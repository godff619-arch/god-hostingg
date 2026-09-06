/**
 * Audit logging — the only writer of the `AuditLog` model (spec §24).
 *
 * Best-effort: never throws into the request path. Records who did what, from
 * where, to which target, and — for sensitive actions — the before/after snapshot
 * plus the operator's stated reason.
 *
 * The rows are immutable by construction rather than by a DB trigger: nothing in
 * the codebase updates or deletes an `AuditLog` except the retention sweeper, and
 * the admin API exposes read-only endpoints for them. Keeping a single writer is
 * what makes that claim checkable.
 *
 * Two call styles, so the ~200 existing call sites keep working:
 *
 *   writeAudit(req, 'project.create', `project:${id}`, { name })      // legacy
 *   writeAudit(req, 'billing.override', { target_type: 'workspace',   // §24
 *     target_id: ws.id, reason, before, after, severity: 'critical' })
 */
import type { AuthenticatedRequest } from './authMiddleware.js';
import prisma from './prisma.js';

/** The §24 fields an audited action can carry. All optional. */
export interface AuditDetails {
  /** `type:id` string kept for backwards compatibility with the old column. */
  resource?: string | null;
  /** "user" | "workspace" | "payment" | "invoice" | "plan" | "server" … */
  target_type?: string | null;
  target_id?: string | null;
  /** Human-readable name of the target at the time of the action. */
  target_label?: string | null;
  /** Operator's justification. Mandatory upstream for overrides and refunds. */
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** info | warning | critical. Drives the severity filter and alerting. */
  severity?: 'info' | 'warning' | 'critical';
  /** Anything else worth keeping; ends up in the `metadata` JSON column. */
  metadata?: unknown;
}

/** Client IP, honouring the first hop of `x-forwarded-for` behind a proxy. */
export function clientIp(req: AuthenticatedRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const first = fwd?.toString().split(',')[0]?.trim();
  return first || req.ip || null;
}

/** Truncated user agent — long enough to identify a client, short enough to store. */
function userAgent(req: AuthenticatedRequest): string | null {
  const ua = req.headers['user-agent'];
  return ua ? ua.toString().slice(0, 400) : null;
}

/**
 * `metadata` used to be the 4th positional argument. Detect an AuditDetails object
 * by its keys so both styles can share one function; anything else is metadata.
 */
function isDetails(value: unknown): value is AuditDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = [
    'resource',
    'target_type',
    'target_id',
    'target_label',
    'reason',
    'before',
    'after',
    'severity',
    'metadata',
  ];
  return Object.keys(value).some((k) => keys.includes(k));
}

/** JSON columns reject `undefined`; normalise to Prisma's "leave unset". */
function json(value: unknown) {
  return value === undefined || value === null ? undefined : (value as object);
}

/**
 * Write an audit row. Swallows all errors — a failed audit write must never break
 * the mutation it describes, and the retention sweeper reports gaps.
 * `userId='internal'` (webhooks, schedulers) is stored as NULL: there is no such
 * User row, and the `actor_email` column records what it was instead.
 */
export async function writeAudit(
  req: AuthenticatedRequest,
  action: string,
  resourceOrDetails?: string | AuditDetails | null,
  metadata?: unknown,
): Promise<void> {
  try {
    const details: AuditDetails = isDetails(resourceOrDetails)
      ? resourceOrDetails
      : { resource: (resourceOrDetails as string | null | undefined) ?? null, metadata };

    const actorId = req.user?.userId;
    const isInternal = actorId === 'internal';
    const user_id = actorId && !isInternal ? actorId : null;

    // `resource` and the split target columns are kept in sync so old readers
    // (the audit-log page filters on `resource`) and new ones both work.
    const resource =
      details.resource ??
      (details.target_type && details.target_id
        ? `${details.target_type}:${details.target_id}`
        : null);
    let target_type = details.target_type ?? null;
    let target_id = details.target_id ?? null;
    if (!target_type && !target_id && resource?.includes(':')) {
      const idx = resource.indexOf(':');
      target_type = resource.slice(0, idx) || null;
      target_id = resource.slice(idx + 1) || null;
    }

    await prisma.auditLog.create({
      data: {
        user_id,
        action,
        resource,
        ip: clientIp(req),
        metadata: json(details.metadata),
        actor_role: req.user?.role ?? null,
        actor_email: req.user?.email ?? (isInternal ? 'internal' : null),
        user_agent: userAgent(req),
        target_type,
        target_id,
        target_label: details.target_label ?? null,
        reason: details.reason ?? null,
        before: json(details.before),
        after: json(details.after),
        severity: details.severity ?? 'info',
      },
    });
  } catch (err) {
    console.warn('[audit] failed to write audit log:', err);
  }
}

/**
 * Audit an action with no HTTP request behind it (webhook processing, schedulers,
 * boot-time reconciliation). Produces the same row shape with `internal` as actor.
 */
export async function writeSystemAudit(
  action: string,
  details: AuditDetails & { ip?: string | null } = {},
): Promise<void> {
  const fake = {
    user: { userId: 'internal', email: 'internal', role: 'system' },
    headers: {},
    ip: details.ip ?? null,
  } as unknown as AuthenticatedRequest;
  await writeAudit(fake, action, details);
}
