// Admin API — cross-tenant operator surface. Mounted at /api/admin behind
// authMiddleware + requireAdmin (the real gate; the frontend role check is cosmetic).
import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { type AuthenticatedRequest, sendAccessError, requireAdminWrite } from '../lib/authMiddleware.js';
import {
  canAssignRole,
  canManageTarget,
  isFullAdmin,
  isOwner,
  privilegedRoleWhere,
} from '../lib/platformRoles.js';
import { writeAudit } from '../lib/audit.js';
import {
  getSetting,
  setSetting,
  getBoolSetting,
  setBoolSetting,
  getJsonSetting,
  setJsonSetting,
} from '../lib/settings.js';
import {
  getRetentionConfig,
  coerceRetentionDays,
  S_AUDIT_RETENTION_DAYS,
  S_ERROR_RETENTION_DAYS,
  S_ERROR_RESOLVED_RETENTION_DAYS,
} from '../lib/retention.js';
import {
  getPlatformDomainConfig,
  previewSubdomain,
  setPlatformDomainConfig,
} from '../lib/platformDomain.js';
import { getSystemStats } from './system.js';
import { getContainerStatus, getDockerEngineInfo } from '../services/docker.js';
import { getCertificateStatus } from '../services/certs.js';
import { getServerPublicIp } from '../services/dnsCheck.js';
import { isMaintenanceMode, maintenanceReason } from '../lib/maintenance.js';
import {
  listArchivedUploads,
  archivedZipPath,
  deleteArchivedUpload,
} from '../lib/uploadArchive.js';

const router = Router();

// Read-only viewers may reach every GET below (mounted via requireAdminAccess in
// index.ts); this gate turns any mutation into a full-admin-only action. Endpoints
// that manage other admins add a stricter super-admin/owner check on top.
router.use(requireAdminWrite);

const QUOTA_KEYS = [
  'ram_mb',
  'cpus_milli',
  'storage_mb',
  'max_apps',
  'max_domains',
  'max_backups',
] as const;
type QuotaKey = (typeof QUOTA_KEYS)[number];

// ── helpers ────────────────────────────────────────────────────────────────
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function parsePaging(req: AuthenticatedRequest): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt((req.query.pageSize as string) || '25', 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** Coerce an override/quota input: '' | null | undefined → null (inherit/unlimited); else Number. */
function coerceQuota(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** RFC-4180 CSV cell: wrap in quotes and double any embedded quotes when needed. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV document from a header row and object rows (keys = columns). */
function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

/** Set download headers for an attachment with a date-stamped filename. */
function sendDownload(res: Response, filenameBase: string, ext: 'csv' | 'json', payload: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  const type = ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}-${stamp}.${ext}"`);
  res.send(payload);
}

/** Hard cap on exported rows — a download, not a data dump that OOMs the server. */
const EXPORT_ROW_CAP = 50_000;

type UserWithRels = Prisma.UserGetPayload<{ include: { plan: true; _count: { select: { projects: true } } } }>;

/**
 * Card on file, for the admin users table. Display metadata only — `brand` and
 * `last4` are all that is stored, so there is nothing sensitive to leak here
 * (the provider token is never selected).
 */
export interface CardSummary {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  count: number;
}

/**
 * Cards per account owner for the given users. A card belongs to a workspace, so
 * "this user saved a card" means: a workspace they own has a payment method.
 * The default card wins; `count` is every card across their workspaces.
 */
async function cardsByOwner(userIds: string[]): Promise<Map<string, CardSummary>> {
  const byOwner = new Map<string, CardSummary>();
  if (userIds.length === 0) return byOwner;
  const rows = await prisma.paymentMethod.findMany({
    where: { workspace: { owner_id: { in: userIds } } },
    orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    select: {
      brand: true,
      last4: true,
      exp_month: true,
      exp_year: true,
      workspace: { select: { owner_id: true } },
    },
  });
  for (const row of rows) {
    const ownerId = row.workspace?.owner_id;
    if (!ownerId) continue;
    const existing = byOwner.get(ownerId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byOwner.set(ownerId, {
      brand: row.brand,
      last4: row.last4,
      exp_month: row.exp_month,
      exp_year: row.exp_year,
      count: 1,
    });
  }
  return byOwner;
}

function mapUser(u: UserWithRels, card?: CardSummary | null) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    plan_id: u.plan_id,
    plan_key: u.plan?.key ?? null,
    plan_name: u.plan?.name ?? null,
    created_at: u.created_at,
    app_count: u._count.projects,
    // Saved card: null when this account has none on file.
    payment_method: card
      ? {
          brand: card.brand,
          last4: card.last4,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
        }
      : null,
    card_count: card?.count ?? 0,
    overrides: {
      ram_mb: u.ram_mb_override,
      cpus_milli: u.cpus_milli_override,
      storage_mb: u.storage_mb_override,
      max_apps: u.max_apps_override,
      max_domains: u.max_domains_override,
      max_backups: u.max_backups_override,
    },
  };
}

async function countAdmins(): Promise<number> {
  return prisma.user.count({ where: privilegedRoleWhere });
}

// ── GET /overview ────────────────────────────────────────────────────────────
router.get('/overview', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const today = startOfToday();
    const [
      usersByStatus,
      appsByStatus,
      databases,
      deploymentsToday,
      failedToday,
      running,
      plans,
      runningContainers,
    ] = await Promise.all([
      prisma.user.groupBy({ by: ['status'], _count: true }),
      prisma.project.groupBy({
        by: ['status'],
        where: { NOT: { project_type: 'database' } },
        _count: true,
      }),
      prisma.project.count({ where: { project_type: 'database' } }),
      prisma.deployment.count({ where: { created_at: { gte: today } } }),
      prisma.deployment.count({
        where: { created_at: { gte: today }, status: { in: ['failed', 'error'] } },
      }),
      prisma.deployment.count({ where: { status: { in: ['in_progress', 'building'] } } }),
      prisma.plan.count(),
      // Cheap approximation: services on projects marked running (no docker fan-out)
      prisma.service.count({ where: { project: { status: 'running' } } }),
    ]);

    const usersMap = Object.fromEntries(usersByStatus.map((r) => [r.status, r._count]));
    const appsMap = Object.fromEntries(appsByStatus.map((r) => [r.status ?? 'unknown', r._count]));
    const appsTotal = appsByStatus.reduce((s, r) => s + r._count, 0);

    let system: Record<string, unknown> = {};
    let health: 'ok' | 'degraded' = 'ok';
    try {
      const s = await getSystemStats();
      const disk = s.disk?.[0];
      const cpuPercent = s.cpu.usage;
      const memUsedPercent = s.memory.usedPercent;
      if (cpuPercent > 90 || memUsedPercent > 90) health = 'degraded';
      system = {
        cpuPercent,
        memUsedPercent,
        memUsed: formatBytes(s.memory.used),
        memTotal: formatBytes(s.memory.total),
        diskUsedPercent: disk?.usedPercent ?? null,
        uptimeSeconds: s.server.uptime,
        uptimeFormatted: s.server.uptimeFormatted,
        rxSpeed: s.network.rxSpeed,
        txSpeed: s.network.txSpeed,
      };
    } catch {
      health = 'degraded';
    }

    res.json({
      users: {
        total: usersByStatus.reduce((s, r) => s + r._count, 0),
        active: usersMap['active'] ?? 0,
        suspended: usersMap['suspended'] ?? 0,
        pending: usersMap['pending'] ?? 0,
      },
      apps: {
        total: appsTotal,
        running: appsMap['running'] ?? 0,
        stopped: appsMap['stopped'] ?? 0,
        failed: (appsMap['failed'] ?? 0) + (appsMap['error'] ?? 0),
        building: appsMap['building'] ?? 0,
        pending: appsMap['pending'] ?? 0,
      },
      databases: { total: databases },
      deployments: { today: deploymentsToday, failedToday, running },
      plans: { total: plans },
      containers: { running: runningContainers },
      system,
      health,
    });
  } catch (error) {
    console.error('[admin] overview failed:', error);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// Operations center — live operational health of the control plane itself.
// Every value is measured at request time; nothing is faked. When a dependency
// (Docker engine, DB, system stats) is unavailable it is reported as such.
router.get('/operations', async (_req: AuthenticatedRequest, res: Response) => {
  const today = startOfToday();

  // Database reachability (also proves Prisma connection is live).
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // Docker engine — honest reachability (not installed / not started → surfaced).
  const docker = await getDockerEngineInfo().catch(() => ({
    cliAvailable: false,
    daemonReachable: false,
    version: null,
    runningContainers: null,
    message: 'Docker engine probe failed.',
  }));

  // Host system stats (best-effort; degrade instead of failing the whole call).
  let system: Record<string, unknown> | null = null;
  try {
    const s = await getSystemStats();
    const disk = s.disk?.[0];
    system = {
      cpuPercent: s.cpu.usage,
      memUsedPercent: s.memory.usedPercent,
      memUsed: formatBytes(s.memory.used),
      memTotal: formatBytes(s.memory.total),
      diskUsedPercent: disk?.usedPercent ?? null,
      diskUsed: formatBytes(disk?.used),
      diskTotal: formatBytes(disk?.total),
      uptimeSeconds: s.server.uptime,
      uptimeFormatted: s.server.uptimeFormatted,
      rxSpeed: s.network.rxSpeed,
      txSpeed: s.network.txSpeed,
    };
  } catch {
    system = null;
  }

  // Recent deployment activity (real counts + last 10 events).
  let deployments: Record<string, unknown> = {};
  try {
    const [todayCount, failedToday, running, recent] = await Promise.all([
      prisma.deployment.count({ where: { created_at: { gte: today } } }),
      prisma.deployment.count({
        where: { created_at: { gte: today }, status: { in: ['failed', 'error'] } },
      }),
      prisma.deployment.count({ where: { status: { in: ['in_progress', 'building'] } } }),
      prisma.deployment.findMany({
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          id: true,
          status: true,
          created_at: true,
          project: { select: { id: true, name: true } },
        },
      }),
    ]);
    deployments = {
      today: todayCount,
      failedToday,
      running,
      recent: recent.map((d) => ({
        id: d.id,
        status: d.status,
        createdAt: d.created_at,
        projectId: d.project?.id ?? null,
        projectName: d.project?.name ?? null,
      })),
    };
  } catch {
    deployments = { today: null, failedToday: null, running: null, recent: [] };
  }

  const proc = process.memoryUsage();

  // Overall health rollup — degraded if a hard dependency is down.
  const health: 'ok' | 'degraded' = dbOk ? 'ok' : 'degraded';

  res.json({
    health,
    instance: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      memoryRss: formatBytes(proc.rss),
      heapUsed: formatBytes(proc.heapUsed),
      heapTotal: formatBytes(proc.heapTotal),
    },
    database: { reachable: dbOk, latencyMs: dbLatencyMs, provider: 'sqlite' },
    docker,
    system,
    deployments,
    maintenance: { enabled: isMaintenanceMode(), reason: maintenanceReason() },
    timestamp: new Date().toISOString(),
  });
});

// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const q = (req.query.q as string)?.trim();
    const status = (req.query.status as string)?.trim();
    const planId = (req.query.plan as string)?.trim();
    const sort = (req.query.sort as string) || 'created_at';
    const order = (req.query.order as string) === 'asc' ? 'asc' : 'desc';

    const where: Prisma.UserWhereInput = {};
    if (status && status !== 'all') where.status = status;
    if (planId && planId !== 'all') where.plan_id = planId;
    if (q) where.OR = [{ name: { contains: q } }, { email: { contains: q } }];
    // Card on file — "who saved a payment method". A card belongs to a workspace,
    // so this asks whether any workspace this user owns has one.
    const card = (req.query.card as string)?.trim();
    if (card === 'yes') where.workspaces = { some: { payment_methods: { some: {} } } };
    else if (card === 'no') where.workspaces = { none: { payment_methods: { some: {} } } };

    let orderBy: Prisma.UserOrderByWithRelationInput;
    if (sort === 'app_count') orderBy = { projects: { _count: order } };
    else if (sort === 'name') orderBy = { name: order };
    else if (sort === 'email') orderBy = { email: order };
    else orderBy = { created_at: order };

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        include: { plan: true, _count: { select: { projects: true } } },
      }),
      prisma.user.count({ where }),
    ]);

    const cards = await cardsByOwner(rows.map((r) => r.id));
    res.json({
      users: rows.map((u) => mapUser(u, cards.get(u.id) ?? null)),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('[admin] list users failed:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});
router.get('/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { plan: true, _count: { select: { projects: true } } },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [apps, databases, deployments, services, subscriptions] = await Promise.all([
      prisma.project.count({ where: { user_id: user.id, NOT: { project_type: 'database' } } }),
      prisma.project.count({ where: { user_id: user.id, project_type: 'database' } }),
      prisma.deployment.count({ where: { project: { user_id: user.id } } }),
      prisma.service.findMany({ where: { project: { user_id: user.id } }, select: { domain: true } }),
      prisma.subscription.findMany({
        where: { user_id: user.id },
        include: { plan: true },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const domainSet = new Set<string>();
    for (const s of services)
      for (const d of (s.domain || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))
        domainSet.add(d);

    const cards = await cardsByOwner([user.id]);
    const mapped = mapUser(user, cards.get(user.id) ?? null);
    // Effective quotas = override ?? plan value (admins => all null/unlimited)
    const effective: Record<QuotaKey, number | null> = {} as Record<QuotaKey, number | null>;
    for (const k of QUOTA_KEYS) {
      const ov = mapped.overrides[k];
      effective[k] = isFullAdmin(user.role) ? null : ov ?? (user.plan ? user.plan[k] : null);
    }

    res.json({
      user: mapped,
      counts: { apps, domains: domainSet.size, deployments, databases },
      effective,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        status: s.status,
        plan_name: s.plan?.name ?? null,
        started_at: s.started_at,
        expires_at: s.expires_at,
      })),
    });
  } catch (error) {
    console.error('[admin] get user failed:', error);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

router.get('/users/:id/apps', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apps = await prisma.project.findMany({
      where: { user_id: req.params.id, NOT: { project_type: 'database' } },
      orderBy: { created_at: 'desc' },
    });
    res.json(apps);
  } catch {
    res.status(500).json({ error: 'Failed to load apps' });
  }
});

router.get('/users/:id/databases', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbs = await prisma.project.findMany({
      where: { user_id: req.params.id, project_type: 'database' },
      orderBy: { created_at: 'desc' },
    });
    res.json(dbs);
  } catch {
    res.status(500).json({ error: 'Failed to load databases' });
  }
});

router.get('/users/:id/deployments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.deployment.findMany({
      where: { project: { user_id: req.params.id } },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(
      rows.map((d) => ({
        id: d.id,
        status: d.status,
        created_at: d.created_at,
        finished_at: d.finished_at,
        durationMs: d.finished_at && d.created_at ? d.finished_at.getTime() - d.created_at.getTime() : null,
        trigger: d.trigger,
        commit_sha: d.commit_sha,
        project: d.project,
      }))
    );
  } catch {
    res.status(500).json({ error: 'Failed to load deployments' });
  }
});

router.get('/users/:id/domains', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const services = await prisma.service.findMany({
      where: { project: { user_id: req.params.id }, NOT: { domain: null } },
      include: { project: { select: { name: true } } },
    });
    const out: Array<{ domain: string; app: string; service: string }> = [];
    for (const s of services)
      for (const d of (s.domain || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))
        out.push({ domain: d, app: s.project?.name ?? '', service: s.name });
    res.json(out);
  } catch {
    res.status(500).json({ error: 'Failed to load domains' });
  }
});

router.get('/users/:id/activity', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { user_id: req.params.id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(logs);
  } catch {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email, password, role, status, plan_id } = req.body ?? {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // Privilege ceiling: you can only mint a role strictly below your own. A plain
    // admin creating an admin, or anyone minting an owner, is rejected here.
    const requestedRole = typeof role === 'string' && role !== 'user' ? role : 'user';
    if (requestedRole !== 'user' && !canAssignRole(req.user?.role, requestedRole)) {
      return res.status(403).json({ error: `You are not permitted to grant the "${requestedRole}" role.` });
    }
    const hashed = await bcrypt.hash(String(password), 12);
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        name: String(name),
        email: String(email).toLowerCase(),
        password: hashed,
        role: requestedRole,
        status: ['active', 'suspended', 'pending'].includes(status) ? status : 'active',
        plan_id: plan_id || null,
        passwordChangedAt: now,
      },
      include: { plan: true, _count: { select: { projects: true } } },
    });
    await writeAudit(req, 'user.create', `user:${user.id}`, { email: user.email, role: user.role });
    res.status(201).json({ user: mapUser(user) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('[admin] create user failed:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.patch('/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // You can only act on accounts strictly below your own tier; the owner is
    // immune to everyone. This is the real guard against lateral/upward edits.
    if (!canManageTarget(req.user?.role, target.role)) {
      return res.status(403).json({
        error: isOwner(target.role)
          ? 'The owner account cannot be modified.'
          : 'You cannot modify an account at or above your own access level.',
      });
    }

    const { name, email, role, status, plan_id, overrides } = req.body ?? {};
    const data: Prisma.UserUpdateInput = {};
    if (typeof name === 'string') data.name = name;
    if (typeof email === 'string') data.email = email.toLowerCase();

    // Guard: never demote or suspend the last privileged operator
    const demoting = role && role !== target.role && !['admin', 'super_admin', 'owner'].includes(role);
    const suspending = status === 'suspended' && target.status !== 'suspended';
    if ((demoting || suspending) && !isOwner(target.role) && (await countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot demote or suspend the last administrator' });
    }
    if (typeof role === 'string' && role !== target.role) {
      // Granting a new role also obeys the privilege ceiling (no self-escalation,
      // no minting a peer). Owner is never assignable via the API.
      if (!canAssignRole(req.user?.role, role)) {
        return res.status(403).json({ error: `You are not permitted to grant the "${role}" role.` });
      }
      data.role = role;
    }
    if (['active', 'suspended', 'pending'].includes(status)) {
      if (status === 'suspended' && target.id === req.user?.userId) {
        return res.status(400).json({ error: 'You cannot suspend your own account' });
      }
      data.status = status;
    }
    if (plan_id !== undefined) {
      data.plan = plan_id ? { connect: { id: plan_id } } : { disconnect: true };
    }
    if (overrides && typeof overrides === 'object') {
      if ('ram_mb' in overrides) data.ram_mb_override = coerceQuota(overrides.ram_mb);
      if ('cpus_milli' in overrides) data.cpus_milli_override = coerceQuota(overrides.cpus_milli);
      if ('storage_mb' in overrides) data.storage_mb_override = coerceQuota(overrides.storage_mb);
      if ('max_apps' in overrides) data.max_apps_override = coerceQuota(overrides.max_apps);
      if ('max_domains' in overrides) data.max_domains_override = coerceQuota(overrides.max_domains);
      if ('max_backups' in overrides) data.max_backups_override = coerceQuota(overrides.max_backups);
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data,
      include: { plan: true, _count: { select: { projects: true } } },
    });
    await writeAudit(req, 'user.update', `user:${user.id}`, { fields: Object.keys(data) });
    res.json({ user: mapUser(user) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('[admin] update user failed:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

async function setUserStatus(
  req: AuthenticatedRequest,
  res: Response,
  status: 'active' | 'suspended'
) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageTarget(req.user?.role, target.role)) {
    return res.status(403).json({
      error: isOwner(target.role)
        ? 'The owner account cannot be modified.'
        : 'You cannot modify an account at or above your own access level.',
    });
  }
  if (status === 'suspended') {
    if (target.id === req.user?.userId)
      return res.status(400).json({ error: 'You cannot suspend your own account' });
    if (!isOwner(target.role) && (await countAdmins()) <= 1)
      return res.status(400).json({ error: 'Cannot suspend the last administrator' });
  }
  const user = await prisma.user.update({
    where: { id: target.id },
    data: { status },
    include: { plan: true, _count: { select: { projects: true } } },
  });
  await writeAudit(req, status === 'suspended' ? 'user.suspend' : 'user.unsuspend', `user:${user.id}`);
  res.json({ user: mapUser(user) });
}

router.post('/users/:id/suspend', async (req, res) => {
  try {
    await setUserStatus(req, res, 'suspended');
  } catch (error) {
    console.error('[admin] suspend failed:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
});

router.post('/users/:id/unsuspend', async (req, res) => {
  try {
    await setUserStatus(req, res, 'active');
  } catch (error) {
    console.error('[admin] unsuspend failed:', error);
    res.status(500).json({ error: 'Failed to unsuspend user' });
  }
});

router.delete('/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user?.userId)
      return res.status(400).json({ error: 'You cannot delete your own account' });
    if (!canManageTarget(req.user?.role, target.role)) {
      return res.status(403).json({
        error: isOwner(target.role)
          ? 'The owner account cannot be deleted.'
          : 'You cannot delete an account at or above your own access level.',
      });
    }
    if (!isOwner(target.role) && (await countAdmins()) <= 1)
      return res.status(400).json({ error: 'Cannot delete the last administrator' });

    // Projects survive with user_id → NULL (schema onDelete: SetNull); surfaced in the UI dialog.
    await prisma.user.delete({ where: { id: target.id } });
    await writeAudit(req, 'user.delete', `user:${target.id}`, { email: target.email });
    res.json({ ok: true });
  } catch (error) {
    console.error('[admin] delete user failed:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── Applications (all tenants) ───────────────────────────────────────────────
router.get('/apps', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      where: { NOT: { project_type: 'database' } },
      orderBy: { created_at: 'desc' },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        deployments: { orderBy: { created_at: 'desc' }, take: 1 },
      },
    });

    const apps = await Promise.all(
      projects.map(async (p) => {
        let container_status = 'unknown';
        let running = false;
        if (p.container_name) {
          try {
            const st = await getContainerStatus(p.container_name);
            container_status = st.status;
            running = st.running;
          } catch {
            /* docker unavailable — leave unknown */
          }
        }
        const last = p.deployments[0];
        return {
          id: p.id,
          name: p.name,
          owner: p.owner
            ? { id: p.owner.id, name: p.owner.name, email: p.owner.email }
            : null,
          project_type: p.project_type,
          source_type: p.source_type,
          build_type: p.build_type,
          status: p.status,
          container_status,
          running,
          domain: p.domain,
          created_at: p.created_at,
          last_deployment: last ? { status: last.status, created_at: last.created_at } : null,
        };
      })
    );
    res.json(apps);
  } catch (error) {
    console.error('[admin] list apps failed:', error);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

// ── Deployments (platform-wide) ───────────────────────────────────────────────
router.get('/deployments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const status = (req.query.status as string)?.trim();
    const where: Prisma.DeploymentWhereInput = {};
    if (status && status !== 'all') where.status = status;

    const [rows, total] = await Promise.all([
      prisma.deployment.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: {
          project: { select: { id: true, name: true, owner: { select: { name: true, email: true } } } },
        },
      }),
      prisma.deployment.count({ where }),
    ]);

    res.json({
      deployments: rows.map((d) => ({
        id: d.id,
        status: d.status,
        created_at: d.created_at,
        finished_at: d.finished_at,
        durationMs:
          d.finished_at && d.created_at ? d.finished_at.getTime() - d.created_at.getTime() : null,
        trigger: d.trigger,
        commit_sha: d.commit_sha,
        project: d.project ? { id: d.project.id, name: d.project.name } : null,
        owner: d.project?.owner ? { name: d.project.owner.name, email: d.project.owner.email } : null,
      })),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('[admin] list deployments failed:', error);
    res.status(500).json({ error: 'Failed to list deployments' });
  }
});

// ── Plans ─────────────────────────────────────────────────────────────────────
type PlanWithCount = Prisma.PlanGetPayload<{ include: { _count: { select: { users: true } } } }>;
function mapPlan(p: PlanWithCount) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    price_cents: p.price_cents,
    currency: p.currency,
    interval: p.interval,
    is_public: p.is_public,
    ram_mb: p.ram_mb,
    cpus_milli: p.cpus_milli,
    storage_mb: p.storage_mb,
    max_apps: p.max_apps,
    max_domains: p.max_domains,
    max_backups: p.max_backups,
    user_count: p._count.users,
  };
}

function planDataFromBody(body: any): Prisma.PlanUncheckedCreateInput {
  return {
    key: String(body.key || '').trim(),
    name: String(body.name || '').trim(),
    price_cents: Number.isFinite(Number(body.price_cents)) ? Math.floor(Number(body.price_cents)) : 0,
    currency: String(body.currency || 'USD'),
    interval: ['month', 'year', 'lifetime'].includes(body.interval) ? body.interval : 'month',
    is_public: body.is_public !== false,
    ram_mb: coerceQuota(body.ram_mb),
    cpus_milli: coerceQuota(body.cpus_milli),
    storage_mb: coerceQuota(body.storage_mb),
    max_apps: coerceQuota(body.max_apps),
    max_domains: coerceQuota(body.max_domains),
    max_backups: coerceQuota(body.max_backups),
  };
}

router.get('/plans', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const plans = await prisma.plan.findMany({
      orderBy: { price_cents: 'asc' },
      include: { _count: { select: { users: true } } },
    });
    res.json(plans.map(mapPlan));
  } catch (error) {
    console.error('[admin] list plans failed:', error);
    res.status(500).json({ error: 'Failed to list plans' });
  }
});

router.post('/plans', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = planDataFromBody(req.body ?? {});
    if (!data.key || !data.name) return res.status(400).json({ error: 'key and name are required' });
    const plan = await prisma.plan.create({
      data,
      include: { _count: { select: { users: true } } },
    });
    await writeAudit(req, 'plan.create', `plan:${plan.id}`, { key: plan.key });
    res.status(201).json({ plan: mapPlan(plan) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'A plan with that key already exists' });
    }
    console.error('[admin] create plan failed:', error);
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

router.patch('/plans/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    const body = req.body ?? {};
    const data: Prisma.PlanUpdateInput = {};
    if (typeof body.name === 'string') data.name = body.name;
    if (body.price_cents !== undefined) data.price_cents = Math.floor(Number(body.price_cents)) || 0;
    if (typeof body.currency === 'string') data.currency = body.currency;
    if (['month', 'year', 'lifetime'].includes(body.interval)) data.interval = body.interval;
    if (body.is_public !== undefined) data.is_public = !!body.is_public;
    for (const k of QUOTA_KEYS) if (k in body) (data as any)[k] = coerceQuota(body[k]);
    // Never rename the immutable stable key; only the admin plan's key is protected from change here.
    if (typeof body.key === 'string' && existing.key !== 'admin') data.key = body.key.trim();

    const plan = await prisma.plan.update({
      where: { id: existing.id },
      data,
      include: { _count: { select: { users: true } } },
    });
    await writeAudit(req, 'plan.update', `plan:${plan.id}`, { fields: Object.keys(data) });
    res.json({ plan: mapPlan(plan) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'A plan with that key already exists' });
    }
    console.error('[admin] update plan failed:', error);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

router.post('/plans/:id/duplicate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const src = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!src) return res.status(404).json({ error: 'Plan not found' });
    let key = `${src.key}-copy`;
    let n = 1;
    while (await prisma.plan.findUnique({ where: { key } })) key = `${src.key}-copy-${++n}`;
    const plan = await prisma.plan.create({
      data: {
        key,
        name: `${src.name} (copy)`,
        price_cents: src.price_cents,
        currency: src.currency,
        interval: src.interval,
        is_public: src.is_public,
        ram_mb: src.ram_mb,
        cpus_milli: src.cpus_milli,
        storage_mb: src.storage_mb,
        max_apps: src.max_apps,
        max_domains: src.max_domains,
        max_backups: src.max_backups,
      },
      include: { _count: { select: { users: true } } },
    });
    await writeAudit(req, 'plan.duplicate', `plan:${plan.id}`, { from: src.id });
    res.status(201).json({ plan: mapPlan(plan) });
  } catch (error) {
    console.error('[admin] duplicate plan failed:', error);
    res.status(500).json({ error: 'Failed to duplicate plan' });
  }
});

router.delete('/plans/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const plan = await prisma.plan.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { users: true } } },
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.key === 'admin') return res.status(400).json({ error: 'The admin plan cannot be deleted' });
    if (plan._count.users > 0) {
      return res
        .status(409)
        .json({ error: `Plan is assigned to ${plan._count.users} user(s). Reassign them first.` });
    }
    await prisma.plan.delete({ where: { id: plan.id } });
    await writeAudit(req, 'plan.delete', `plan:${plan.id}`, { key: plan.key });
    res.json({ ok: true });
  } catch (error) {
    console.error('[admin] delete plan failed:', error);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// ── Domains (platform-wide hostnames) ─────────────────────────────────────────
// Every hostname the platform serves for a tenant, plus the base domain that new
// apps are published under. Certificate state is read for the current page only —
// resolving it walks the certbot directory per hostname.
router.get('/domains', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const search = String(req.query.search ?? '').trim().toLowerCase();

    const [cfg, services, serverIp] = await Promise.all([
      getPlatformDomainConfig(),
      prisma.service.findMany({
        where: { domain: { not: null } },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          domain: true,
          status: true,
          created_at: true,
          project: {
            select: {
              id: true,
              name: true,
              owner: { select: { id: true, name: true, email: true } },
            },
          },
        },
      }),
      getServerPublicIp().catch(() => null),
    ]);

    // One row per hostname — `Service.domain` holds a comma-separated list.
    const rows = services.flatMap((svc) =>
      String(svc.domain ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
        .map((hostname) => ({
          hostname,
          service_id: svc.id,
          service_name: svc.name,
          project_id: svc.project?.id ?? null,
          project_name: svc.project?.name ?? null,
          owner: svc.project?.owner ?? null,
          status: svc.status,
          created_at: svc.created_at,
          // Under the platform's own domain (issued by us) vs a tenant's own domain.
          managed: !!cfg.baseDomain && hostname.endsWith(`.${cfg.baseDomain}`),
        })),
    );

    const filtered = search
      ? rows.filter(
          (r) =>
            r.hostname.includes(search) ||
            (r.project_name ?? '').toLowerCase().includes(search) ||
            (r.owner?.email ?? '').toLowerCase().includes(search),
        )
      : rows;

    const pageRows = filtered.slice(skip, skip + pageSize);
    const withSsl = await Promise.all(
      pageRows.map(async (row) => {
        try {
          const ssl = await getCertificateStatus(row.hostname);
          return { ...row, ssl: { status: ssl.status, expires_at: ssl.expiresAt } };
        } catch {
          return { ...row, ssl: null };
        }
      }),
    );

    res.json({
      domains: withSsl,
      total: filtered.length,
      page,
      pageSize,
      server_ip: serverIp,
      config: {
        base_domain: cfg.baseDomain ?? '',
        auto_subdomain_enabled: cfg.autoSubdomain,
        subdomain_template: cfg.template,
        example: cfg.baseDomain ? previewSubdomain('my-app', 'my-app', cfg) : null,
      },
      counts: {
        managed: filtered.filter((r) => r.managed).length,
        custom: filtered.filter((r) => !r.managed).length,
      },
    });
  } catch (error) {
    console.error('[admin] list domains failed:', error);
    res.status(500).json({ error: 'Failed to list domains' });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
const S_PLATFORM_NAME = 'platform_name';
const S_REGISTRATION = 'registration_enabled';
const S_DEPLOYMENTS = 'deployments_enabled';
const S_DEFAULT_PLAN = 'default_plan_key';
const S_MAINTENANCE = 'maintenance_mode';
const S_MAINTENANCE_MSG = 'maintenance_message';
const S_FEATURE_FLAGS = 'feature_flags';

async function readSettings() {
  const [name, defaultPlan, msg, flags, reg, dep, maint, retention, domainCfg] = await Promise.all([
    getSetting(S_PLATFORM_NAME),
    getSetting(S_DEFAULT_PLAN),
    getSetting(S_MAINTENANCE_MSG),
    getJsonSetting<Record<string, boolean>>(S_FEATURE_FLAGS, {}),
    getBoolSetting(S_REGISTRATION, true),
    getBoolSetting(S_DEPLOYMENTS, true),
    getBoolSetting(S_MAINTENANCE, false),
    getRetentionConfig(),
    getPlatformDomainConfig(),
  ]);
  return {
    platform_name: name ?? 'Docklift',
    registration_enabled: reg,
    deployments_enabled: dep,
    default_plan_key: defaultPlan ?? 'free',
    maintenance_mode: maint,
    maintenance_message: msg ?? '',
    feature_flags: flags,
    // Platform base domain — user apps are published as <app>.<base_domain>.
    base_domain: domainCfg.baseDomain ?? '',
    auto_subdomain_enabled: domainCfg.autoSubdomain,
    subdomain_template: domainCfg.template,
    // Log retention in days; 0 = keep forever.
    audit_retention_days: retention.auditDays,
    error_retention_days: retention.errorDays,
    error_resolved_retention_days: retention.errorResolvedDays,
  };
}

router.get('/settings', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await readSettings());
  } catch (error) {
    console.error('[admin] read settings failed:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body ?? {};
    // Base domain / subdomain template are validated first: a bad hostname must
    // reject the whole request rather than half-apply the rest of the form.
    if (
      b.base_domain !== undefined ||
      b.subdomain_template !== undefined ||
      b.auto_subdomain_enabled !== undefined
    ) {
      try {
        await setPlatformDomainConfig(b);
      } catch (domainErr) {
        return res
          .status(400)
          .json({ error: domainErr instanceof Error ? domainErr.message : 'Invalid domain settings' });
      }
    }
    if (typeof b.platform_name === 'string') await setSetting(S_PLATFORM_NAME, b.platform_name);
    if (typeof b.default_plan_key === 'string') await setSetting(S_DEFAULT_PLAN, b.default_plan_key);
    if (typeof b.maintenance_message === 'string')
      await setSetting(S_MAINTENANCE_MSG, b.maintenance_message);
    if (b.registration_enabled !== undefined)
      await setBoolSetting(S_REGISTRATION, !!b.registration_enabled);
    if (b.deployments_enabled !== undefined)
      await setBoolSetting(S_DEPLOYMENTS, !!b.deployments_enabled);
    if (b.maintenance_mode !== undefined) await setBoolSetting(S_MAINTENANCE, !!b.maintenance_mode);
    if (b.feature_flags && typeof b.feature_flags === 'object')
      await setJsonSetting(S_FEATURE_FLAGS, b.feature_flags);

    // Log retention (days; 0 = keep forever). Coerced + clamped; invalid → ignored.
    const auditDays = coerceRetentionDays(b.audit_retention_days);
    if (auditDays !== null) await setSetting(S_AUDIT_RETENTION_DAYS, String(auditDays));
    const errorDays = coerceRetentionDays(b.error_retention_days);
    if (errorDays !== null) await setSetting(S_ERROR_RETENTION_DAYS, String(errorDays));
    const resolvedDays = coerceRetentionDays(b.error_resolved_retention_days);
    if (resolvedDays !== null)
      await setSetting(S_ERROR_RESOLVED_RETENTION_DAYS, String(resolvedDays));

    await writeAudit(req, 'settings.update', null, { fields: Object.keys(b) });
    res.json({ settings: await readSettings() });
  } catch (error) {
    console.error('[admin] update settings failed:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── Audit logs ──────────────────────────────────────────────────────────────
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const action = (req.query.action as string)?.trim();
    const userId = (req.query.userId as string)?.trim();
    const where: Prisma.AuditLogWhereInput = {};
    if (action) where.action = { contains: action };
    if (userId) where.user_id = userId;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: { user: { select: { name: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      logs: rows.map((l) => ({
        id: l.id,
        action: l.action,
        resource: l.resource,
        ip: l.ip,
        created_at: l.created_at,
        // The actor id, so the page can filter to one account and link to it.
        // Null after the account is deleted (onDelete: SetNull) or for internal work.
        user_id: l.user_id,
        user: l.user ? { name: l.user.name, email: l.user.email } : null,
        metadata: l.metadata,
      })),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('[admin] list audit logs failed:', error);
    res.status(500).json({ error: 'Failed to list audit logs' });
  }
});

// GET /audit-logs/export?format=csv|json — full download honoring the same
// filters as the list (no paging; capped). Read-only, so viewers may export too.
router.get('/audit-logs/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const format = (req.query.format as string) === 'json' ? 'json' : 'csv';
    const action = (req.query.action as string)?.trim();
    const userId = (req.query.userId as string)?.trim();
    const where: Prisma.AuditLogWhereInput = {};
    if (action) where.action = { contains: action };
    if (userId) where.user_id = userId;

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
      include: { user: { select: { name: true, email: true } } },
    });
    const records = rows.map((l) => ({
      id: l.id,
      created_at: l.created_at.toISOString(),
      action: l.action,
      resource: l.resource ?? '',
      user_id: l.user_id ?? '',
      user_email: l.user?.email ?? '',
      user_name: l.user?.name ?? '',
      ip: l.ip ?? '',
      metadata: l.metadata ?? null,
    }));

    await writeAudit(req, 'audit.export', null, { count: records.length, format });
    if (format === 'json') {
      sendDownload(res, 'audit-logs', 'json', JSON.stringify(records, null, 2));
    } else {
      const cols = ['id', 'created_at', 'action', 'resource', 'user_id', 'user_email', 'user_name', 'ip', 'metadata'];
      sendDownload(res, 'audit-logs', 'csv', toCsv(cols, records));
    }
  } catch (error) {
    console.error('[admin] export audit logs failed:', error);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

// ── user ZIP uploads (operator-visible archive) ─────────────────────────────
router.get('/uploads', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const uploads = await listArchivedUploads();
    res.json({
      uploads: uploads.map((u) => ({
        id: u.id,
        originalName: u.originalName,
        sizeBytes: u.sizeBytes,
        sizeFormatted: formatBytes(u.sizeBytes),
        userId: u.userId,
        userEmail: u.userEmail,
        projectId: u.projectId,
        projectName: u.projectName,
        uploadedAt: u.uploadedAt,
      })),
      total: uploads.length,
    });
  } catch (error) {
    console.error('[admin] list uploads failed:', error);
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

router.get('/uploads/:id/download', async (req: AuthenticatedRequest, res: Response) => {
  const zip = archivedZipPath(req.params.id);
  if (!zip) return res.status(404).json({ error: 'Upload not found' });
  await writeAudit(req, 'upload.download', `upload:${req.params.id}`);
  res.download(zip, `${req.params.id}.zip`);
});

router.delete('/uploads/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const removed = await deleteArchivedUpload(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Upload not found' });
    await writeAudit(req, 'upload.delete', `upload:${req.params.id}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[admin] delete upload failed:', error);
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});

// ── Error Center ─────────────────────────────────────────────────────────────
// Grouped platform errors. Rows are written by lib/errorCenter.ts (the Express
// error handler, boot checks and background workers); this surface only reads,
// annotates and clears them.

/** Shape one group for the UI. `detail` is only sent from the detail endpoint. */
function mapErrorGroup(e: ErrorEventRow, includeDetail = false) {
  return {
    id: e.id,
    fingerprint: e.fingerprint,
    level: e.level,
    source: e.source,
    message: e.message,
    route: e.route,
    status_code: e.status_code,
    request_id: e.request_id,
    resource: e.resource,
    workspace_id: e.workspace_id,
    count: e.count,
    first_seen_at: e.first_seen_at,
    last_seen_at: e.last_seen_at,
    resolved_at: e.resolved_at,
    resolved_by: e.resolved_by,
    user: e.user ? { id: e.user.id, name: e.user.name, email: e.user.email } : null,
    ...(includeDetail ? { detail: e.detail } : {}),
  };
}

type ErrorEventRow = Prisma.ErrorEventGetPayload<{
  include: { user: { select: { id: true; name: true; email: true } } };
}>;

const ERROR_USER_INCLUDE = {
  user: { select: { id: true, name: true, email: true } },
} as const;

router.get('/errors', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const status = String(req.query.status ?? 'open');
    const source = (req.query.source as string) || '';
    const q = ((req.query.q as string) || '').trim();

    const where: Prisma.ErrorEventWhereInput = {};
    if (status === 'open') where.resolved_at = null;
    else if (status === 'resolved') where.resolved_at = { not: null };
    if (source) where.source = source;
    if (q) {
      where.OR = [
        { message: { contains: q } },
        { route: { contains: q } },
        { resource: { contains: q } },
        { request_id: { contains: q } },
      ];
    }

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [rows, total, openCount, resolvedCount, recentCount, bySource] = await Promise.all([
      prisma.errorEvent.findMany({
        where,
        include: ERROR_USER_INCLUDE,
        orderBy: { last_seen_at: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.errorEvent.count({ where }),
      prisma.errorEvent.count({ where: { resolved_at: null } }),
      prisma.errorEvent.count({ where: { resolved_at: { not: null } } }),
      prisma.errorEvent.count({ where: { last_seen_at: { gte: dayAgo } } }),
      prisma.errorEvent.groupBy({
        by: ['source'],
        _count: { _all: true },
        _sum: { count: true },
      }),
    ]);

    res.json({
      errors: rows.map((e) => mapErrorGroup(e)),
      page,
      pageSize,
      total,
      summary: {
        open: openCount,
        resolved: resolvedCount,
        // Groups touched in the last 24h — "is anything breaking right now".
        active_24h: recentCount,
        sources: bySource
          .map((s) => ({
            source: s.source,
            groups: s._count._all,
            occurrences: s._sum.count ?? 0,
          }))
          .sort((a, b) => b.occurrences - a.occurrences),
      },
    });
  } catch (error) {
    console.error('[admin] list errors failed:', error);
    res.status(500).json({ error: 'Failed to load errors' });
  }
});

// GET /errors/export?format=csv|json — full download of error groups honoring
// the list filters. Declared BEFORE /errors/:id so "export" isn't read as an id.
router.get('/errors/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const format = (req.query.format as string) === 'json' ? 'json' : 'csv';
    const status = String(req.query.status ?? 'all');
    const source = (req.query.source as string) || '';
    const q = ((req.query.q as string) || '').trim();

    const where: Prisma.ErrorEventWhereInput = {};
    if (status === 'open') where.resolved_at = null;
    else if (status === 'resolved') where.resolved_at = { not: null };
    if (source) where.source = source;
    if (q) {
      where.OR = [
        { message: { contains: q } },
        { route: { contains: q } },
        { resource: { contains: q } },
        { request_id: { contains: q } },
      ];
    }

    const rows = await prisma.errorEvent.findMany({
      where,
      include: ERROR_USER_INCLUDE,
      orderBy: { last_seen_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    const records = rows.map((e) => ({
      id: e.id,
      fingerprint: e.fingerprint,
      level: e.level,
      source: e.source,
      status: e.resolved_at ? 'resolved' : 'open',
      count: e.count,
      message: e.message,
      route: e.route ?? '',
      status_code: e.status_code ?? '',
      resource: e.resource ?? '',
      request_id: e.request_id ?? '',
      user_email: e.user?.email ?? '',
      first_seen_at: e.first_seen_at.toISOString(),
      last_seen_at: e.last_seen_at.toISOString(),
      resolved_at: e.resolved_at ? e.resolved_at.toISOString() : '',
    }));

    await writeAudit(req, 'error.export', null, { count: records.length, format });
    if (format === 'json') {
      sendDownload(res, 'error-events', 'json', JSON.stringify(records, null, 2));
    } else {
      const cols = [
        'id', 'fingerprint', 'level', 'source', 'status', 'count', 'message', 'route',
        'status_code', 'resource', 'request_id', 'user_email', 'first_seen_at',
        'last_seen_at', 'resolved_at',
      ];
      sendDownload(res, 'error-events', 'csv', toCsv(cols, records));
    }
  } catch (error) {
    console.error('[admin] export errors failed:', error);
    res.status(500).json({ error: 'Failed to export errors' });
  }
});

router.get('/errors/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.errorEvent.findUnique({
      where: { id: req.params.id },
      include: ERROR_USER_INCLUDE,
    });
    if (!row) return res.status(404).json({ error: 'Error group not found' });
    res.json({ error_group: mapErrorGroup(row, true) });
  } catch (error) {
    console.error('[admin] get error failed:', error);
    res.status(500).json({ error: 'Failed to load error' });
  }
});

/**
 * Resolving is an operator note ("I have seen this"), not a fix. If the same
 * failure happens again, `recordError` clears `resolved_at` — so this can never
 * permanently silence a live problem.
 */
router.post('/errors/:id/resolve', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.errorEvent.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Error group not found' });
    const updated = await prisma.errorEvent.update({
      where: { id: row.id },
      data: { resolved_at: new Date(), resolved_by: req.user?.userId ?? null },
      include: ERROR_USER_INCLUDE,
    });
    await writeAudit(req, 'error.resolve', `error:${row.id}`, { fingerprint: row.fingerprint });
    res.json({ error_group: mapErrorGroup(updated, true) });
  } catch (error) {
    console.error('[admin] resolve error failed:', error);
    res.status(500).json({ error: 'Failed to resolve error' });
  }
});

router.post('/errors/:id/reopen', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.errorEvent.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Error group not found' });
    const updated = await prisma.errorEvent.update({
      where: { id: row.id },
      data: { resolved_at: null, resolved_by: null },
      include: ERROR_USER_INCLUDE,
    });
    await writeAudit(req, 'error.reopen', `error:${row.id}`);
    res.json({ error_group: mapErrorGroup(updated, true) });
  } catch (error) {
    console.error('[admin] reopen error failed:', error);
    res.status(500).json({ error: 'Failed to reopen error' });
  }
});

/** Bulk-resolve every open group, optionally limited to one source. */
router.post('/errors/resolve-all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = typeof req.body?.source === 'string' && req.body.source ? req.body.source : null;
    const result = await prisma.errorEvent.updateMany({
      where: { resolved_at: null, ...(source ? { source } : {}) },
      data: { resolved_at: new Date(), resolved_by: req.user?.userId ?? null },
    });
    await writeAudit(req, 'error.resolve_all', null, { source, count: result.count });
    res.json({ resolved: result.count });
  } catch (error) {
    console.error('[admin] resolve-all failed:', error);
    res.status(500).json({ error: 'Failed to resolve errors' });
  }
});

router.delete('/errors/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.errorEvent.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Error group not found' });
    await prisma.errorEvent.delete({ where: { id: row.id } });
    await writeAudit(req, 'error.delete', `error:${row.id}`, { fingerprint: row.fingerprint });
    res.json({ ok: true });
  } catch (error) {
    console.error('[admin] delete error failed:', error);
    res.status(500).json({ error: 'Failed to delete error' });
  }
});

/**
 * Clear resolved groups now. Only ever deletes groups an operator already marked
 * resolved — an open error cannot be discarded by accident from here.
 */
router.delete('/errors', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await prisma.errorEvent.deleteMany({ where: { resolved_at: { not: null } } });
    await writeAudit(req, 'error.clear_resolved', null, { count: result.count });
    res.json({ deleted: result.count });
  } catch (error) {
    console.error('[admin] clear resolved errors failed:', error);
    res.status(500).json({ error: 'Failed to clear errors' });
  }
});

export default router;