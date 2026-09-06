// Express server entry point - configures middleware, routes, and starts the Docklift backend
import './lib/loadEnv.js';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './lib/config.js';
import { ensureNetwork } from './services/docker.js';
import { logBootstrapIfNeeded } from './lib/bootstrap.js';
import { isTrustedOrigin } from './lib/originCheck.js';
import { resolveStaticSite, isServerRoute, isBuiltAssetPath } from './lib/staticSite.js';
import { isMaintenanceMode, maintenanceReason } from './lib/maintenance.js';
import {
  isRestoreCritical,
  loadRestoreCriticalOnBoot,
  restoreCriticalMarkerPath,
} from './lib/restoreCritical.js';
import { dedupeEnvVariables } from './lib/envVariables.js';
import { requestId, getRequestId } from './lib/requestId.js';
import { recordError, recordRequestError } from './lib/errorCenter.js';
import { runRetentionSweep } from './lib/retention.js';
import { sweepLapsedSubscriptions } from './lib/billingState.js';
import { requireFeatureForWrites } from './lib/featureFlags.js';
import { platformMaintenanceGate } from './lib/platformSwitches.js';
import { drainQueued, seedEmailTemplates } from './lib/mailer.js';
import {
  apiLimiter,
  backupLimiter,
  deployLimiter,
  provisionLimiter,
  webhookLimiter,
} from './lib/rateLimits.js';

import projectsRouter from './routes/projects.js';
import deploymentsRouter from './routes/deployments.js';
import filesRouter from './routes/files.js';
import portsRouter from './routes/ports.js';
import githubRouter from './routes/github.js';
import systemRouter from './routes/system.js';
import domainRouter from './routes/domains.js';
import backupRouter from './routes/backup.js';
import logsRouter from './routes/logs.js';
import databasesRouter from './routes/databases.js';
import authRouter from './routes/auth.js';
import publicRouter from './routes/public.js';
import adminRouter from './routes/admin.js';
import adminBillingRouter from './routes/adminBilling.js';
import adminCommsRouter from './routes/adminComms.js';
import adminSecurityRouter from './routes/adminSecurity.js';
import workspaceRouter from './routes/workspace.js';
import billingRouter from './routes/billing.js';
import paymentWebhooksRouter from './routes/paymentWebhooks.js';
import integrationsRouter from './routes/integrations.js';
import envGroupsRouter from './routes/envGroups.js';
import notificationsRouter from './routes/notifications.js';
import supportRouter from './routes/support.js';
import privateLinksRouter from './routes/privateLinks.js';
import blueprintsRouter from './routes/blueprints.js';
import { authMiddleware, sseAuthMiddleware, requireAdminAccess, adminApiKeyAuth, attachLiveRole } from './lib/authMiddleware.js';
import { adminPermissionGate } from './lib/adminPermissions.js';
import { startUptimeTracking, stopUptimeTracking } from './lib/uptime.js';
import { setupTerminalWebSocket, cleanupAllSessions } from './services/terminal.js';
import { startCertRenewWatcher } from './services/certs.js';
import { reloadNginx, syncNginxConfigs } from './services/nginx.js';
import prisma from './lib/prisma.js';
import { recoverDeploymentStateOnBoot } from './lib/deploymentRecovery.js';
import { ensureOwnerExists } from './lib/ensureOwner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// General auth limiter (login, password change, etc.)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/status',
});

// Stricter limiter for first-account / bootstrap claim surface (public panel by design)
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many setup attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Correlation id first — every response (including errors) carries X-Request-Id
app.use(requestId);

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS only when the request itself is HTTPS (terminate TLS at reverse proxy)
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || '').toString();
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS: explicit allowlist, else same origin (scheme + host + port) as this request
app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      // Non-browser clients omit Origin; the JWT is still the gate
      if (!origin) return callback(null, true);
      const allowed = isTrustedOrigin(origin, req.headers, {
        fallbackProto: req.protocol,
        allow: [config.frontendUrl],
      });
      return callback(null, allowed);
    },
    credentials: true,
  })(req, res, next);
});

// Payment provider webhooks — mounted BEFORE the JSON parser and before any auth.
//
// Signature verification is an HMAC over the exact bytes the provider sent, so the
// body must not be parsed and re-serialised first; `express.raw` hands the router a
// Buffer. There is no session on these requests — the signature is the credential
// (spec §34) — which is why this line sits above `authMiddleware`.
app.use(
  '/api/billing/webhooks',
  express.raw({ type: '*/*', limit: '2mb' }),
  paymentWebhooksRouter,
);

// Middleware
// SECURITY: Capture raw body for webhook signature verification (HMAC needs original bytes)
app.use(express.json({
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Trust only the first proxy (nginx) - prevents IP spoofing for rate limiting
app.set('trust proxy', 1);

// Ensure directories exist — always use configured DATA_PATH (not a hardcoded ./data)
const dataDir = config.dataPath;
const deploymentsDir = config.deploymentsPath;

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(deploymentsDir)) {
  fs.mkdirSync(deploymentsDir, { recursive: true });
}
if (!fs.existsSync(config.backupPath)) {
  fs.mkdirSync(config.backupPath, { recursive: true });
}

// Generate a unique ID for this server instance at startup
const INSTANCE_ID = crypto.randomUUID();

// Liveness/readiness probes (non-/api, unauthenticated, bypass maintenance gate).
// These are for load balancers / orchestrators (Render, k8s, Docker healthcheck).
//   /health/live  — process is up and the event loop responds. Always 200.
//   /health/ready — dependencies (DB) are reachable. 200 ready / 503 not ready.
app.get('/health/live', (_req, res) => {
  res.json({ status: 'live', instanceId: INSTANCE_ID, uptime: process.uptime() });
});
app.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', instanceId: INSTANCE_ID });
  } catch (err) {
    res.status(503).json({
      status: 'not-ready',
      reason: 'database unavailable',
      detail: (err as Error)?.message,
    });
  }
});

// During restore / critical recovery: gate API traffic
app.use((req, res, next) => {
  if (isRestoreCritical()) {
    if (req.path === '/api/health') return next();
    // Explicit operator recovery only — never another normal restore
    if (
      req.path === '/api/backup/clear-critical-restore' ||
      req.path === '/api/backup/critical-status'
    ) {
      return next();
    }
    return res.status(503).json({
      error: maintenanceReason(),
      maintenance: true,
      critical: true,
      sealPath: restoreCriticalMarkerPath(),
    });
  }
  if (!isMaintenanceMode()) return next();
  if (req.path === '/api/health') return next();
  // Active restore stream only (blocked when critical above)
  if (req.path.startsWith('/api/backup/restore')) return next();
  return res.status(503).json({ error: maintenanceReason(), maintenance: true });
});

// Health check (public)
app.get('/api/health', (req, res) => {
  let version = 'unknown';
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    version = pkg.version;
  } catch (e) {
    // Try one level up (for dist structure)
    try {
      const pkgPathDist = path.resolve(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPathDist, 'utf8'));
      version = pkg.version;
    } catch { /* ignore */ }
  }
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    version,
    instanceId: INSTANCE_ID 
  });
});

// Auth routes (public, rate limited)
app.use('/api/auth/register', setupLimiter);
app.use('/api/auth/setup-token', setupLimiter);
app.use('/api/auth', authLimiter, authRouter);

// The marketing homepage's data (pricing, whether signups are open). Mounted here,
// ahead of the maintenance gate, on purpose: a maintenance window means the
// *product* is paused, and answering the front door with a 503 would tell a
// first-time visitor the company is gone. It carries its own IP-keyed limiter
// because the global one deliberately skips GETs.
app.use('/api/public', publicRouter);

// Protected routes - apply auth middleware
// A generous per-user/IP ceiling across the whole authenticated API (stops a
// runaway script; normal dashboard polling stays far under it). Tight,
// cost-shaped limiters below only guard mutations — `mutating()` lets GET
// polling (deploy status, backup list) through untouched.
const mutating = (limiter: express.RequestHandler): express.RequestHandler => (req, res, next) =>
  req.method === 'GET' || req.method === 'HEAD' ? next() : limiter(req, res, next);

app.use('/api', apiLimiter);

// Operator maintenance window (Admin → Settings). Normal users get a 503 the
// frontend renders as a maintenance page; the ops center and sign-in stay up so
// whoever enabled it can turn it off again. Distinct from the restore-time gate
// above, which blocks everyone including admins.
app.use('/api', platformMaintenanceGate);

// Ops center. All four routers sit behind the same chain; admin.ts installs the
// per-action permission gate itself, and the sibling mounts are passed the same gate
// explicitly because they are sibling mounts, not child routers. Splitting the files
// is an organisational choice — it is not a second trust boundary.
//
// `adminApiKeyAuth` runs first so a machine key (§31) can authenticate; without the
// header it is a no-op and the request falls through to the JWT. `attachLiveRole`
// then replaces the token's week-old role claim with the live one, so a demotion
// takes effect on the next request instead of at token expiry.
const adminChain = [adminApiKeyAuth, authMiddleware, attachLiveRole, requireAdminAccess] as const;
app.use('/api/admin', ...adminChain, adminRouter);
app.use('/api/admin', ...adminChain, adminPermissionGate, adminBillingRouter);
app.use('/api/admin', ...adminChain, adminPermissionGate, adminCommsRouter);
app.use('/api/admin', ...adminChain, adminPermissionGate, adminSecurityRouter);
app.use('/api/workspace', authMiddleware, workspaceRouter);
app.use('/api/billing', authMiddleware, billingRouter);
app.use('/api/integrations', authMiddleware, integrationsRouter);
// Feature flags (Admin → Feature Flags) gate writes only, so switching a feature
// off never hides what a user already has — see lib/featureFlags.ts.
app.use('/api/env-groups', authMiddleware, requireFeatureForWrites('env_groups'), envGroupsRouter);
app.use('/api/notifications', authMiddleware, notificationsRouter);
// Customer-facing support tickets (§23). The admin inbox reads the same rows; this
// is the surface that puts anything in them.
app.use('/api/support', authMiddleware, supportRouter);
app.use(
  '/api/private-links',
  authMiddleware,
  requireFeatureForWrites('private_links'),
  privateLinksRouter,
);
app.use('/api/blueprints', authMiddleware, requireFeatureForWrites('blueprints'), blueprintsRouter);
app.use('/api/projects', authMiddleware, mutating(provisionLimiter), projectsRouter);
app.use('/api/deployments', authMiddleware, mutating(deployLimiter), deploymentsRouter);
app.use(
  '/api/databases',
  authMiddleware,
  mutating(provisionLimiter),
  requireFeatureForWrites('databases'),
  databasesRouter,
);
app.use('/api/files', authMiddleware, requireFeatureForWrites('file_manager'), filesRouter);
app.use('/api/ports', authMiddleware, portsRouter);
app.use('/api/github', (req, res, next) => {
  // Allow public access for webhooks and callbacks
  const publicPaths = ['/webhook', '/callback', '/manifest/callback', '/setup'];
  if (publicPaths.some(p => req.path.startsWith(p))) {
    // The webhook is unauthenticated by design — its own IP-keyed limiter blunts
    // a delivery flood before signature verification does the real gating.
    if (req.method === 'POST' && req.path.startsWith('/webhook')) {
      return webhookLimiter(req, res, next);
    }
    return next();
  }
  return authMiddleware(req, res, next);
}, githubRouter);
app.use('/api/system', (req, res, next) => {
  // SSE log streams use short-lived query tokens; all other system APIs require Bearer session JWT
  if (req.method === 'GET' && req.path.startsWith('/logs/')) {
    return sseAuthMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, systemRouter);
app.use(
  '/api/domains',
  authMiddleware,
  mutating(provisionLimiter),
  requireFeatureForWrites('custom_domains'),
  domainRouter,
);
app.use('/api/logs', (req, res, next) => {
  // Only container log SSE uses query SSE tokens; container list stays Bearer-only
  if (req.method === 'GET' && /\/stream\//.test(req.path)) {
    return sseAuthMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, logsRouter);
app.use('/api/backup', async (req, res, next) => {
  // Fresh-install restore: validate setup token but do NOT consume yet.
  // Token + bootstrap secret are consumed only after a successful restore
  // (see backup.ts → consumeSetupRestoreSecrets).
  if (req.path === '/restore-upload' && req.method === 'POST') {
    const setupToken = req.headers['x-setup-token'] as string | undefined;
    const { validateSetupToken } = await import('./lib/setupRestoreAuth.js');
    if (validateSetupToken(setupToken)) {
      (req as import('./lib/setupRestoreAuth.js').SetupRestoreRequest).setupTokenAuth = true;
      console.log('[SECURITY] Restore-upload authorized via setup token (deferred consume)');
      return next();
    }
    return authMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}, mutating(backupLimiter), backupRouter);

// Single-container mode: serve the built dashboard from this same port when a
// build is present (see lib/staticSite.ts). Registered after every API router so
// it can never shadow one, and before the error handler so failures still surface.
const siteDir = resolveStaticSite(__dirname);
if (siteDir) {
  // Hashed assets are safe to cache hard; index.html must never be cached or
  // browsers keep loading a stale bundle after an upgrade.
  app.use(
    express.static(siteDir, {
      index: false,
      etag: true,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(`${path.sep}index.html`)) res.setHeader('Cache-Control', 'no-store');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // Client-side routes (/setup, /project/:id, …) must return the SPA shell, while
  // an unmatched /api or /ws path has to fall through to the API's own 404 —
  // answering it with the dashboard would make every typo look like a live page.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isServerRoute(req.path) || isBuiltAssetPath(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(siteDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

// Error handler — logs with the correlation id and echoes it to the client so a
// user-reported failure can be traced to the exact request in the logs. The same
// failure is grouped into the Error Center; only 5xx is recorded, because a 4xx
// is the client being told "no" and would drown the real faults.
app.use((err: Error & { status?: number; statusCode?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const reqId = getRequestId(req);
  console.error(`[error] reqId=${reqId || '-'} ${req.method} ${req.path}\n`, err.stack || err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    void recordRequestError(req, 'api', err, status);
  }
  if (res.headersSent) return next(err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status === 500 || !err.message ? 'Something went wrong!' : err.message,
    requestId: reqId,
  });
});

// Start server
async function main() {
  try {
    // Re-seal critical restore state from disk before accepting traffic
    loadRestoreCriticalOnBoot();

    // Guarantee the platform has an OWNER (legacy/restored DBs may have none).
    await ensureOwnerExists();

    // Create any built-in email template that is missing (§21). Non-fatal, and it
    // never overwrites an operator's edit — a redeploy must not silently revert the
    // wording someone changed in Admin → Email.
    try {
      await seedEmailTemplates();
    } catch (mailErr: any) {
      console.warn(`⚠️  Email templates not seeded (${mailErr?.message || 'error'})`);
    }

    // Open this boot's uptime session before accepting traffic. Doing it here is
    // what lets the status page report the outage that just ended: the gap is
    // measured against the previous session's last heartbeat.
    await startUptimeTracking();

    // Ensure Docker network exists (non-fatal so auth/API can run without Docker for local smoke)
    try {
      await ensureNetwork();
      console.log(`🐳 Docker network "${config.dockerNetwork}" ready`);
    } catch (dockerErr: any) {
      const reason = dockerErr?.code || dockerErr?.message || 'error';
      console.warn(`⚠️  Docker unavailable (${reason}) — API starting without Docker`);
      // Surfaced in the Error Center: "why is nothing deploying?" has an answer
      // in the UI, not only in whatever scrolled past in the console at boot.
      void recordError({
        source: 'docker',
        level: 'warn',
        message: `Docker engine unavailable at startup (${reason})`,
        detail: dockerErr?.stack || String(dockerErr),
        resource: `network:${config.dockerNetwork}`,
      });
    }
    
    const server = app.listen(config.port, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚀 Docklift Backend (Node.js)                           ║
║                                                            ║
║   Server running at: http://localhost:${config.port}                ║
║   Deployments path:  ${config.deploymentsPath}                      
║                                                            ║
╚════════════════════════════════════════════════════════════╝
      `);

      if (siteDir) {
        console.log(`🖥️  Dashboard served from ${siteDir} on the same port (single-container mode)\n`);
      }

      // Clean up orphaned Nginx configs on startup
      syncNginxConfigs().catch(console.error);
    });

    // Attach WebSocket terminal server to HTTP server
    setupTerminalWebSocket(server);

    // Fresh install: print bootstrap secret to logs (never via public API)
    await logBootstrapIfNeeded();

    await recoverDeploymentStateOnBoot();

    // Docker-free services: correct any native process marked running whose PID no
    // longer exists after this restart (in-memory child handles don't survive it).
    try {
      const { reconcileNativeOnBoot } = await import('./services/nativeRuntime.js');
      reconcileNativeOnBoot();
    } catch (nativeErr) {
      console.warn('[startup] Native runtime reconcile skipped:', nativeErr);
    }

    try {
      const removed = await dedupeEnvVariables();
      if (removed > 0) {
        console.log(`[startup] Removed ${removed} duplicate env_variables row(s)`);
      }
    } catch (envErr) {
      console.warn('[startup] Env dedupe skipped:', envErr);
    }

    // After certbot renew updates PEMs, reload nginx-proxy
    startCertRenewWatcher(() => reloadNginx());

    // Log retention: sweep audit trail + Error Center at boot, then daily, using
    // operator-configured retention (admin /settings). `unref` so a pending timer
    // never holds the process open during shutdown.
    const prune = () => {
      void runRetentionSweep().then(({ audit, errors }) => {
        if (audit > 0) console.log(`[retention] pruned ${audit} stale audit log(s)`);
        if (errors > 0) console.log(`[retention] pruned ${errors} stale error group(s)`);
      });
    };
    prune();
    const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
    pruneTimer.unref();

    // Billing lapse sweep: move workspaces whose paid period ended off the paid plan
    // and honour `cancel_at_period_end`. Hourly rather than daily so a cancellation
    // takes effect on the day it was due. `effectivePlanKey()` already refuses to
    // honour a lapsed period, so a missed run leaves a stale status column, never
    // free Pro — this sweep is what makes the column agree with reality.
    const sweepBilling = () => {
      void sweepLapsedSubscriptions()
        .then((count) => {
          if (count > 0) console.log(`[billing] ${count} subscription(s) lapsed`);
        })
        .catch((err) => console.warn('[billing] lapse sweep failed:', err));
    };
    sweepBilling();
    const billingTimer = setInterval(sweepBilling, 60 * 60 * 1000);
    billingTimer.unref();

    // Mail queue: a mail written while SMTP was unconfigured (or while the relay was
    // down) is stored with its rendered body and status `queued`. This is what
    // eventually sends it. Every five minutes, and a no-op when SMTP is off — so
    // configuring SMTP later still delivers the invoices already waiting, and nothing
    // is ever marked sent that the transport did not accept.
    const sweepMail = () => {
      void drainQueued(25)
        .then(({ sent, failed }) => {
          if (sent > 0 || failed > 0) console.log(`[mailer] drained queue: ${sent} sent, ${failed} failed`);
        })
        .catch((err) => console.warn('[mailer] queue drain failed:', err));
    };
    sweepMail();
    const mailTimer = setInterval(sweepMail, 5 * 60 * 1000);
    mailTimer.unref();

    // A crash the operator never sees is the worst kind. Record it, then let the
    // default behaviour stand: an uncaught exception leaves the process in an
    // unknown state, so we exit rather than pretend to keep serving.
    process.on('unhandledRejection', (reason) => {
      const err = reason as Error;
      console.error('[fatal] unhandled promise rejection:', err?.stack || reason);
      void recordError({
        source: 'internal',
        message: `Unhandled promise rejection: ${err?.message || String(reason)}`,
        detail: err?.stack || String(reason),
      });
    });
    process.on('uncaughtException', (err) => {
      console.error('[fatal] uncaught exception:', err?.stack || err);
      void recordError({
        source: 'internal',
        message: `Uncaught exception: ${err?.message || String(err)}`,
        detail: err?.stack || String(err),
      }).finally(() => process.exit(1));
    });

    // Graceful shutdown: stop accepting connections, drain, then release
    // resources. A hard deadline guarantees the process actually dies even if a
    // socket refuses to close — otherwise a restart would hang forever.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n🛑 ${signal} received — shutting down gracefully...`);
      const forceExit = setTimeout(() => {
        console.warn('   Drain timed out after 15s — forcing exit');
        process.exit(1);
      }, 15_000);
      forceExit.unref();

      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log('   HTTP server closed');
          resolve();
        });
      });
      cleanupAllSessions();
      console.log('   Terminal sessions cleaned up');
      clearInterval(pruneTimer);
      // Mark the uptime session as a clean exit, so the status page can call this
      // a planned restart instead of listing it as a crash.
      await stopUptimeTracking();
      await prisma.$disconnect();
      console.log('   Database disconnected');
      clearTimeout(forceExit);
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
