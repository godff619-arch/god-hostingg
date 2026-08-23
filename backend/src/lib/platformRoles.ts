/**
 * Platform (ops-center) role tiers — the RBAC hierarchy behind `/api/admin`.
 *
 * This is a DIFFERENT axis from workspace membership roles (see workspace.ts:
 * owner|admin|developer|viewer scoped to one team). This axis is platform-wide:
 * who may operate the whole install.
 *
 *   owner        — the root account, minted at bootstrap. Exactly one exists and
 *                  it is untouchable: it can never be demoted, suspended, deleted,
 *                  or edited by anyone (including itself via the role field). It
 *                  can manage every other account.
 *   super_admin  — can manage admins, viewers and users (create/promote/demote/
 *                  suspend/delete), but can never touch the owner.
 *   admin        — full read/write of the ops center and every tenant's resources
 *                  (this is the historical "admin" — behaviour preserved exactly).
 *                  May manage plain users and viewers, but NOT other admins.
 *   viewer       — read-only ops center. Every GET under /api/admin is allowed;
 *                  every mutation is 403. Does NOT bypass tenant ownership/quota.
 *   user         — a normal customer. No ops-center access at all.
 *
 * `owner`, `super_admin` and `admin` are "full admins": they bypass per-tenant
 * ownership and quota (see isAdmin in authMiddleware). `viewer` deliberately does
 * NOT — its reach is confined to the admin router's own cross-tenant queries.
 *
 * Roles are stored as a plain string on User.role (no schema/enum change), so a
 * legacy install full of role:'admin' rows keeps working untouched; boot-time
 * reconciliation only ever *adds* an owner (see ensureOwnerExists).
 */
export type PlatformRole = 'user' | 'viewer' | 'admin' | 'super_admin' | 'owner';

/** Strict privilege ordering. Higher rank ⇒ strictly more authority. */
const RANK: Record<PlatformRole, number> = {
  user: 0,
  viewer: 1,
  admin: 2,
  super_admin: 3,
  owner: 4,
};

/** Any string that isn't a known tier is treated as the least-privileged `user`. */
export function rankOf(role: string | null | undefined): number {
  return RANK[(role ?? '') as PlatformRole] ?? 0;
}

/** Roles that bypass tenant ownership + quota (the historical "admin" set). */
export function isFullAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.admin;
}

/** Roles allowed to reach the ops center at all (read-only viewer included). */
export function hasAdminAccess(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.viewer;
}

/** Roles allowed to manage other admin-tier accounts. */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.super_admin;
}

export function isOwner(role: string | null | undefined): boolean {
  return rankOf(role) === RANK.owner;
}

/**
 * Roles that constitute "an operator exists" for boot/restore/reset checks that
 * historically counted role:'admin'. Owner and super_admin must count too, or a
 * fresh owner-only install would look admin-less.
 */
export const PRIVILEGED_ROLES: PlatformRole[] = ['owner', 'super_admin', 'admin'];

/** Prisma `where` fragment matching any privileged (operator) account. */
export const privilegedRoleWhere = { role: { in: PRIVILEGED_ROLES } } as const;

/**
 * Can `actorRole` assign `targetRole` to someone? An actor may only grant roles
 * STRICTLY below its own rank — this blocks privilege escalation (an admin can't
 * mint an admin; a super_admin can't mint a super_admin). `owner` is never
 * grantable through the API; it exists only via bootstrap/reconciliation.
 */
export function canAssignRole(actorRole: string | undefined, targetRole: string): boolean {
  if (targetRole === 'owner') return false;
  if (!ASSIGNABLE_ROLES.includes(targetRole as PlatformRole)) return false;
  return rankOf(actorRole) > rankOf(targetRole);
}

/** Roles that may ever be set through the admin API (owner excluded by design). */
export const ASSIGNABLE_ROLES: PlatformRole[] = ['user', 'viewer', 'admin', 'super_admin'];

/**
 * Can `actorRole` modify/suspend/delete the account `targetRole`? You may only
 * act on accounts strictly below your own rank. The owner is therefore immune to
 * everyone, and no one can act on a peer of equal rank.
 */
export function canManageTarget(actorRole: string | undefined, targetRole: string): boolean {
  if (isOwner(targetRole)) return false; // owner is untouchable, always
  return rankOf(actorRole) > rankOf(targetRole);
}
