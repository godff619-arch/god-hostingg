// Platform (ops-center) role tiers — the frontend mirror of the backend's
// lib/platformRoles.ts. These checks are COSMETIC: they decide what UI to show,
// never what is permitted. Every /api/admin endpoint is enforced server-side
// (requireAdminAccess + adminPermissionGate + per-action super-admin checks).
//
//   owner > super_admin > admin > operations_admin > billing_admin
//         > support_admin > viewer > user
//
// owner/super_admin/admin are "full admins" (read + write the whole ops center).
// The three scoped tiers can write only inside their own area — which permission
// they hold is answered by the server (`GET /api/admin/me` → `permissions`), not
// by this file. viewer is read-only. user has no ops-center access.
//
// Rank numbers are spaced by ten to match the backend exactly, so a tier can be
// slotted in later without renumbering.

const RANK: Record<string, number> = {
  user: 0,
  viewer: 10,
  support_admin: 20,
  billing_admin: 25,
  operations_admin: 30,
  admin: 40,
  super_admin: 50,
  owner: 60,
};

export function rankOf(role: string | null | undefined): number {
  return RANK[role ?? ""] ?? 0;
}

/** May reach the admin area at all (viewer included, read-only). */
export function hasAdminAccess(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.viewer;
}

/** May perform write actions anywhere in the ops center (owner/super_admin/admin). */
export function isFullAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.admin;
}

/** In the admin area but read-only — used to hide/disable mutating controls. */
export function isViewerOnly(role: string | null | undefined): boolean {
  return rankOf(role) === RANK.viewer;
}

/**
 * One of the scoped tiers: writes in its own area, refused elsewhere. Such a role
 * must not have its controls blanket-disabled the way a viewer's are — ask the
 * server-supplied permission list instead.
 */
export function isScopedAdmin(role: string | null | undefined): boolean {
  const rank = rankOf(role);
  return rank > RANK.viewer && rank < RANK.admin;
}

/** May manage other admin-tier accounts (owner/super_admin). */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.super_admin;
}

export function isOwner(role: string | null | undefined): boolean {
  return rankOf(role) === RANK.owner;
}

/** Human label for a platform role tier. Mirrors ROLE_LABELS on the backend. */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "super_admin":
      return "Super Admin";
    case "admin":
      return "Administrator";
    case "operations_admin":
      return "Operations Admin";
    case "billing_admin":
      return "Billing Admin";
    case "support_admin":
      return "Support Admin";
    case "viewer":
      return "Read-only Admin";
    default:
      return "User";
  }
}
