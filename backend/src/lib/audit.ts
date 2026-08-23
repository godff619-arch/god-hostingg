/**
 * Audit logging — first writer of the `AuditLog` model.
 *
 * Best-effort: never throws into the request path. Records who did what, from
 * where. Actor + IP are pulled from the authenticated request.
 */
import type { AuthenticatedRequest } from './authMiddleware.js';
import prisma from './prisma.js';

/**
 * Write an audit row. Swallows all errors (audit must never break a mutation).
 * `userId='internal'` is stored as NULL (no such User row).
 */
export async function writeAudit(
  req: AuthenticatedRequest,
  action: string,
  resource?: string | null,
  metadata?: unknown
): Promise<void> {
  try {
    const actorId = req.user?.userId;
    const user_id = actorId && actorId !== 'internal' ? actorId : null;
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || null) as
      | string
      | null;
    await prisma.auditLog.create({
      data: {
        user_id,
        action,
        resource: resource ?? null,
        ip,
        metadata: metadata === undefined ? undefined : (metadata as object),
      },
    });
  } catch (err) {
    console.warn('[audit] failed to write audit log:', err);
  }
}
