/**
 * Admin → Security (spec §29, §30, §31). Mounted at `/api/admin` beside the other
 * admin routers, behind the same chain and the same table-driven permission gate
 * (`/security` and `/sessions` need `security.view` / `security.manage`, `/api-keys`
 * needs `security.view` / `apikeys.manage`).
 *
 * Every number on the page is a `count` over a real table. There is no "99.9%" and
 * no seeded demo row: a fresh install shows zeros and empty states, which is the
 * honest answer to "has anyone tried to break in yet" (§53).
 *
 * The three surfaces:
 *
 *   /security/overview   — the dashboard: failed sign-ins, locked accounts, live
 *                          operator sessions, suspicious sessions, key health.
 *   /security/attempts   — the sign-in attempt log, filterable by outcome.
 *   /sessions            — live operator sessions; revoke one, or all of a user's.
 *   /api-keys            — machine credentials; create (plaintext shown once),
 *                          revoke, and see when each was last used.
 *
 * Two rules that are enforced here rather than in the UI:
 *
 *   - Killing *someone else's* session requires a super-admin (owner/super_admin).
 *     `security.manage` is enough to end your own sessions; ending another
 *     operator's is an account action, and the schema says so too.
 *   - A key can never be minted with permissions the creator does not themselves
 *     hold. Otherwise `apikeys.manage` would be a privilege-escalation primitive:
 *     mint a key with `users.delete`, then use it.
 */
import { Router, Response } from 'express';
import prisma from '../lib/prisma.js';
import { type AuthenticatedRequest } from '../lib/authMiddleware.js';
import { isSuperAdmin } from '../lib/platformRoles.js';
import {
  PERMISSIONS,
  requestPermissions,
  type Permission,
} from '../lib/adminPermissions.js';
import { writeAudit } from '../lib/audit.js';
import {
  API_KEY_HEADER,
  createApiKey,
  keyPermissions,
  revokeSession,
  revokeSessionsForUser,
  sanitizePermissions,
} from '../lib/security.js';

const router = Router();

/** Attempt-log page size. Long enough to see a burst, short enough to scan. */
const ATTEMPT_PAGE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Outcomes the filter offers, in the order the UI shows them. */
const OUTCOMES = ['ok', 'bad_password', 'unknown_user', 'suspended', 'pending', 'locked'] as const;

function parsePage(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// ---------------------------------------------------------------------------
//  §29 — the dashboard
// ---------------------------------------------------------------------------

router.get('/security/overview', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const soon = new Date(now.getTime() + 7 * DAY_MS);

    const [
      failed24h,
      failed7d,
      success24h,
      lockedAccounts,
      liveSessions,
      suspiciousSessions,
      activeKeys,
      expiringKeys,
      recentAttempts,
      recentSessions,
      adminAccounts,
    ] = await Promise.all([
      prisma.loginAttempt.count({ where: { success: false, created_at: { gte: since24h } } }),
      prisma.loginAttempt.count({ where: { success: false, created_at: { gte: since7d } } }),
      prisma.loginAttempt.count({ where: { success: true, created_at: { gte: since24h } } }),
      prisma.user.count({ where: { locked_until: { gt: now } } }),
      prisma.adminSession.count({ where: { revoked_at: null, expires_at: { gt: now } } }),
      prisma.adminSession.count({
        where: { revoked_at: null, expires_at: { gt: now }, suspicious: true },
      }),
      prisma.adminApiKey.count({
        where: { revoked_at: null, OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
      }),
      prisma.adminApiKey.count({
        where: { revoked_at: null, expires_at: { gt: now, lte: soon } },
      }),
      prisma.loginAttempt.findMany({
        orderBy: { created_at: 'desc' },
        take: 8,
        select: { id: true, email: true, ip: true, outcome: true, success: true, created_at: true },
      }),
      prisma.adminSession.findMany({
        where: { revoked_at: null, expires_at: { gt: now } },
        orderBy: { last_seen_at: 'desc' },
        take: 5,
        select: {
          id: true,
          user_id: true,
          ip: true,
          device: true,
          suspicious: true,
          last_seen_at: true,
        },
      }),
      // Accounts holding admin access, for the "who can get in at all" line.
      prisma.user.count({
        where: {
          role: {
            in: ['owner', 'super_admin', 'admin', 'operations_admin', 'billing_admin', 'support_admin', 'viewer'],
          },
        },
      }),
    ]);

    // Top offending addresses over the week. Grouped in SQL, not in JS over every
    // row, so the query stays flat as the table grows.
    const offenders = await prisma.loginAttempt.groupBy({
      by: ['ip'],
      where: { success: false, created_at: { gte: since7d }, ip: { not: null } },
      _count: { ip: true },
      orderBy: { _count: { ip: 'desc' } },
      take: 5,
    });

    const userIds = Array.from(new Set(recentSessions.map((s) => s.user_id)));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    res.json({
      totals: {
        failed_24h: failed24h,
        failed_7d: failed7d,
        success_24h: success24h,
        locked_accounts: lockedAccounts,
        live_sessions: liveSessions,
        suspicious_sessions: suspiciousSessions,
        active_keys: activeKeys,
        expiring_keys: expiringKeys,
        admin_accounts: adminAccounts,
      },
      recent_attempts: recentAttempts,
      recent_sessions: recentSessions.map((s) => ({
        ...s,
        email: byId.get(s.user_id)?.email ?? null,
        name: byId.get(s.user_id)?.name ?? null,
      })),
      offenders: offenders.map((o) => ({ ip: o.ip, attempts: o._count.ip })),
    });
  } catch (error) {
    console.error('[admin] security overview failed:', error);
    res.status(500).json({ error: 'Failed to load security overview' });
  }
});

router.get('/security/attempts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parsePage(req.query.page);
    const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : 'all';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const where: Record<string, unknown> = {};
    if (outcome === 'failed') where.success = false;
    else if (outcome !== 'all' && (OUTCOMES as readonly string[]).includes(outcome)) {
      where.outcome = outcome;
    }
    if (q) {
      where.OR = [{ email: { contains: q } }, { ip: { contains: q } }];
    }

    const [total, rows] = await Promise.all([
      prisma.loginAttempt.count({ where }),
      prisma.loginAttempt.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * ATTEMPT_PAGE,
        take: ATTEMPT_PAGE,
        select: {
          id: true,
          email: true,
          ip: true,
          user_agent: true,
          outcome: true,
          success: true,
          created_at: true,
        },
      }),
    ]);

    res.json({ attempts: rows, total, page, page_size: ATTEMPT_PAGE, outcomes: OUTCOMES });
  } catch (error) {
    console.error('[admin] security attempts failed:', error);
    res.status(500).json({ error: 'Failed to load sign-in attempts' });
  }
});

// ---------------------------------------------------------------------------
//  §30 — sessions
// ---------------------------------------------------------------------------

router.get('/sessions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const includeEnded = req.query.ended === '1';
    const now = new Date();
    const rows = await prisma.adminSession.findMany({
      where: includeEnded ? {} : { revoked_at: null, expires_at: { gt: now } },
      orderBy: { last_seen_at: 'desc' },
      take: 100,
    });

    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true, role: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    res.json({
      sessions: rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        email: byId.get(r.user_id)?.email ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: byId.get(r.user_id)?.role ?? null,
        ip: r.ip,
        device: r.device,
        user_agent: r.user_agent,
        suspicious: r.suspicious,
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        revoked_by: r.revoked_by,
        // The caller's own sessions are labelled so the UI can warn before an
        // operator signs themselves out of the page they are standing on.
        is_self: r.user_id === req.user?.userId,
      })),
      total: rows.length,
      includes_ended: includeEnded,
    });
  } catch (error) {
    console.error('[admin] sessions list failed:', error);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

router.delete('/sessions/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = await prisma.adminSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const isOwnSession = session.user_id === req.user?.userId;
    if (!isOwnSession && !isSuperAdmin(req.user?.role)) {
      return res
        .status(403)
        .json({ error: "Ending another operator's session requires a super administrator." });
    }
    if (session.revoked_at) {
      return res.status(409).json({ error: 'That session has already ended.' });
    }

    await revokeSession(session.id, isOwnSession ? 'self' : (req.user?.userId ?? 'admin'));
    const target = isOwnSession
      ? null
      : await prisma.user.findUnique({
          where: { id: session.user_id },
          select: { email: true },
        });
    await writeAudit(req, 'security.session.revoke', {
      target_type: 'session',
      target_id: session.id,
      target_label: target?.email ?? session.device ?? session.ip ?? session.id,
      severity: isOwnSession ? 'info' : 'warning',
      metadata: { user_id: session.user_id, ip: session.ip, device: session.device },
    });
    res.json({ message: isOwnSession ? 'Session signed out.' : 'Session revoked.' });
  } catch (error) {
    console.error('[admin] session revoke failed:', error);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

/**
 * Sign out every session of one account (`user` query param, default: the caller).
 *
 * The caller's own current token is spared when they target themselves — the point
 * of "sign out my other devices" is that this one keeps working.
 */
router.post('/sessions/revoke-all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const targetId =
      typeof req.body?.user_id === 'string' && req.body.user_id ? req.body.user_id : req.user?.userId;
    if (!targetId) return res.status(400).json({ error: 'No account to sign out' });

    const isSelf = targetId === req.user?.userId;
    if (!isSelf && !isSuperAdmin(req.user?.role)) {
      return res
        .status(403)
        .json({ error: 'Signing another operator out everywhere requires a super administrator.' });
    }

    const currentToken = isSelf
      ? req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || undefined
      : undefined;
    const count = await revokeSessionsForUser(
      targetId,
      isSelf ? 'self' : (req.user?.userId ?? 'admin'),
      currentToken,
    );

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { email: true },
    });
    await writeAudit(req, 'security.sessions.revoke_all', {
      target_type: 'user',
      target_id: targetId,
      target_label: target?.email ?? targetId,
      severity: isSelf ? 'info' : 'warning',
      metadata: { revoked: count, kept_current: Boolean(currentToken) },
    });
    res.json({
      message:
        count === 0
          ? 'No other sessions were live.'
          : `${count} session${count === 1 ? '' : 's'} signed out.`,
      revoked: count,
    });
  } catch (error) {
    console.error('[admin] revoke-all failed:', error);
    res.status(500).json({ error: 'Failed to sign sessions out' });
  }
});

// ---------------------------------------------------------------------------
//  §31 — machine API keys
// ---------------------------------------------------------------------------

router.get('/api-keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.adminApiKey.findMany({ orderBy: { created_at: 'desc' }, take: 200 });
    const creatorIds = Array.from(
      new Set(rows.map((r) => r.created_by).filter((v): v is string => Boolean(v))),
    );
    const creators = creatorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, email: true },
        })
      : [];
    const byId = new Map(creators.map((u) => [u.id, u.email]));
    const now = Date.now();

    res.json({
      // The header a client sends the key in, so the UI can document it without
      // hardcoding a string that only this module actually knows.
      header: API_KEY_HEADER,
      // Only permissions the caller holds are offered, for the same reason the
      // create endpoint refuses the rest.
      grantable: requestPermissions(req),
      all_permissions: PERMISSIONS,
      keys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.key_prefix,
        permissions: keyPermissions(r.permissions),
        created_by: r.created_by,
        created_by_email: r.created_by ? (byId.get(r.created_by) ?? null) : null,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        status: r.revoked_at
          ? 'revoked'
          : r.expires_at && r.expires_at.getTime() < now
            ? 'expired'
            : 'active',
      })),
    });
  } catch (error) {
    console.error('[admin] api key list failed:', error);
    res.status(500).json({ error: 'Failed to load API keys' });
  }
});

router.post('/api-keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length < 3) {
      return res.status(400).json({ error: 'Give the key a name of at least 3 characters.' });
    }

    const wanted = sanitizePermissions(req.body?.permissions);
    if (wanted.length === 0) {
      return res.status(400).json({ error: 'A key with no permissions could not do anything.' });
    }

    // No escalation: you cannot mint a credential stronger than yourself.
    const held = new Set<Permission>(requestPermissions(req));
    const excess = wanted.filter((p) => !held.has(p));
    if (excess.length) {
      return res.status(403).json({
        error: `You cannot grant a key permissions you do not hold: ${excess.join(', ')}.`,
      });
    }

    let expiresAt: Date | null = null;
    if (req.body?.expires_at) {
      const parsed = new Date(req.body.expires_at);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Expiry is not a valid date.' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Expiry must be in the future.' });
      }
      expiresAt = parsed;
    }

    const created = await createApiKey({
      name,
      permissions: wanted,
      expiresAt,
      createdBy: req.user?.userId ?? null,
    });

    await writeAudit(req, 'security.apikey.create', {
      target_type: 'api_key',
      target_id: created.id,
      target_label: name,
      severity: 'warning',
      // The secret is never audited. The prefix identifies the row; the plaintext
      // exists only in the response below.
      metadata: { prefix: created.prefix, permissions: wanted, expires_at: expiresAt },
    });

    res.status(201).json({
      message: 'API key created. Copy it now — it is not shown again.',
      key: { id: created.id, name, prefix: created.prefix, secret: created.secret },
      header: API_KEY_HEADER,
    });
  } catch (error) {
    console.error('[admin] api key create failed:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/api-keys/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const key = await prisma.adminApiKey.findUnique({ where: { id: req.params.id } });
    if (!key) return res.status(404).json({ error: 'API key not found' });
    if (key.revoked_at) return res.status(409).json({ error: 'That key is already revoked.' });

    await prisma.adminApiKey.update({
      where: { id: key.id },
      data: { revoked_at: new Date() },
    });
    await writeAudit(req, 'security.apikey.revoke', {
      target_type: 'api_key',
      target_id: key.id,
      target_label: key.name,
      severity: 'warning',
      metadata: { prefix: key.key_prefix },
    });
    res.json({ message: 'API key revoked. Any client using it stops working immediately.' });
  } catch (error) {
    console.error('[admin] api key revoke failed:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;
