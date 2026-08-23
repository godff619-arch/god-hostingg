// Platform (ops-center) role tiers — the frontend mirror of the backend's
// lib/platformRoles.ts. These checks are COSMETIC: they decide what UI to show,
// never what is permitted. Every /api/admin endpoint is enforced server-side
// (requireAdminAccess + requireAdminWrite + per-action super-admin checks).
//
//   owner > super_admin > admin > viewer > user
//
// owner/super_admin/admin are "full admins" (read + write the ops center).
// viewer is read-only. user has no ops-center access.

const RANK: Record<string, number> = {
  user: 0,
  viewer: 1,
  admin: 2,
  super_admin: 3,
  owner: 4,
};

export function rankOf(role: string | null | undefined): number {
  return RANK[role ?? ""] ?? 0;
}

/** May reach the admin area at all (viewer included, read-only). */
export function hasAdminAccess(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.viewer;
}

/** May perform write actions in the ops center (owner/super_admin/admin). */
export function isFullAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.admin;
}

/** In the admin area but read-only — used to hide/disable mutating controls. */
export function isViewerOnly(role: string | null | undefined): boolean {
  return rankOf(role) === RANK.viewer;
}

/** May manage other admin-tier accounts (owner/super_admin). */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return rankOf(role) >= RANK.super_admin;
}

export function isOwner(role: string | null | undefined): boolean {
  return rankOf(role) === RANK.owner;
}

/** Human label for a platform role tier. */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "super_admin":
      return "Super Admin";
    case "admin":
      return "Administrator";
    case "viewer":
      return "Viewer";
    default:
      return "User";
  }
}
