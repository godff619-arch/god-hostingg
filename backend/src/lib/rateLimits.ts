/**
 * Rate limiters (spec Part D).
 *
 * Two problems this file solves that a single global limiter cannot:
 *
 * 1. **Fair keying.** An authenticated request is keyed by user id, not IP, so
 *    one tenant hammering an endpoint cannot exhaust the budget for everyone
 *    behind the same NAT/office IP — and a logged-in user cannot dodge the limit
 *    by rotating IPs. Unauthenticated requests fall back to the IP, run through
 *    `ipKeyGenerator` so IPv6 is collapsed to a /56 subnet (a single client owns
 *    a whole v6 range otherwise). `trust proxy` is already `1` (see index.ts), so
 *    `req.ip` is the real client, not nginx.
 *
 * 2. **Cost-shaped budgets.** Reading a list is cheap; kicking off a deploy spawns
 *    Docker builds, and taking a backup tars the whole data dir. Those get their
 *    own, much tighter limiters rather than sharing the read budget.
 *
 * A tripped limit is itself an operational signal, so every limiter records one
 * grouped `api`/`warn` event (never per-hit — the group's `count` is the tally).
 * Recording is best-effort and never blocks the 429.
 */
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from './authMiddleware.js';
import { getRequestId } from './requestId.js';
import { recordError } from './errorCenter.js';

/** Authenticated → `user:<id>`; else the (IPv6-safe) client IP. */
function keyByUserOrIp(req: Request): string {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (userId) return `user:${userId}`;
  return ipKeyGenerator(req.ip ?? '');
}

/**
 * Build a limiter with the shared defaults. `name` only labels the recorded
 * error group so an operator can tell *which* surface is being hammered.
 */
function makeLimiter(name: string, windowMs: number, max: number, opts: Partial<Options> = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyByUserOrIp,
    message: { error: 'Too many requests, please slow down and try again shortly.' },
    // A 429 is a symptom worth seeing in the Error Center, but only as one group.
    handler: (req: Request, res: Response, _next, options) => {
      void recordError({
        source: 'api',
        level: 'warn',
        message: `Rate limit hit: ${name}`,
        route: `${req.method} ${req.baseUrl || ''}${req.route?.path ?? req.path}`,
        statusCode: 429,
        requestId: getRequestId(req) ?? null,
        userId: (req as AuthenticatedRequest).user?.userId ?? null,
      });
      res.status(options.statusCode).json(options.message);
    },
    ...opts,
  });
}

// Expensive, side-effectful, or abusable surfaces get their own budget.

/** Deploy/redeploy/restart/rollback — each spawns Docker work. */
export const deployLimiter = makeLimiter('deploy', 5 * 60 * 1000, 30);

/** Backup create/restore — tars or untars the whole data dir. */
export const backupLimiter = makeLimiter('backup', 15 * 60 * 1000, 10);

/** Project/database/domain creation — provisions real resources. */
export const provisionLimiter = makeLimiter('provision', 60 * 1000, 20);

/** Public GitHub webhook — unauthenticated by design, so keyed by IP only. */
export const webhookLimiter = makeLimiter('webhook', 60 * 1000, 60, {
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
});

/**
 * Coarse abuse backstop for the whole `/api` surface, mounted before per-router
 * auth (so it keys by IP, not user). Reads are cheap and the dashboard polls a
 * lot of GETs, so this only counts mutations — a write-flood from one IP is the
 * thing worth ceiling-ing globally; the tight limiters above do the real,
 * per-user shaping once auth has run.
 */
export const apiLimiter = makeLimiter('api', 60 * 1000, 300, {
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  skip: (req: Request) =>
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    req.path === '/health' ||
    req.path.startsWith('/health/') ||
    /\/(stream|logs)\//.test(req.path),
});
