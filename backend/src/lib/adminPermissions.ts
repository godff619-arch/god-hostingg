/**
 * Admin RBAC — the granular permission layer behind `/api/admin/*` (spec §2, §47).
 *
 * WHY THIS SHAPE
 * --------------
 * The install already had a coarse platform-role ladder (`platformRoles.ts`:
 * owner > super_admin > admin > viewer > user) and every admin endpoint was gated
 * on "is a full admin". The spec needs six named admin roles with per-action
 * permissions — `billing.refund`, `servers.manage`, `users.suspend` — and it needs
 * them enforced *server-side*, per endpoint.
 *
 * Rather than stand up a second identity store (`admin_users` + its own password
 * table), which would fork sign-in and leave two places to suspend an account,
 * the scoped roles are added to the *existing* ladder and the permission matrix
 * lives here in code. Consequences that matter:
 *
 *   - one account, one password, one suspension switch, one session lockout;
 *   - a legacy row with `role = 'admin'` keeps exactly the authority it had;
 *   - the matrix is reviewable in one file instead of being spread across rows
 *     an admin could edit to grant themselves `billing.refund`.
 *
 * ROLE ↔ SPEC NAME
 * ----------------
 *   owner            — root account, minted at bootstrap, untouchable. All perms.
 *   super_admin      — SUPER_ADMIN. All perms.
 *   admin            — ADMIN. Everything except managing other admin accounts.
 *   operations_admin — OPERATIONS_ADMIN. Infrastructure, no money, no accounts.
 *   billing_admin    — BILLING_ADMIN. Money, no infrastructure, no accounts.
 *   support_admin    — SUPPORT_ADMIN. Tickets + read-only customer context.
 *   viewer           — READ_ONLY_ADMIN. Every `.view`, no mutation anywhere.
 *
 * The scoped tiers deliberately do NOT satisfy `isFullAdmin()`, so none of them
 * inherits the blanket tenant-ownership/quota bypass that owner/super_admin/admin
 * have on the *tenant* APIs. Their reach is exactly the admin router, exactly the
 * permissions listed below.
 */
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './authMiddleware.js';
import { ASSIGNABLE_ROLES, canAssignRole, type PlatformRole } from './platformRoles.js';

/** Every permission the admin surface can demand. Grouped as the spec lists them. */
export const PERMISSIONS = [
  // Customers
  'users.view',
  'users.create',
  'users.edit',
  'users.suspend',
  'users.delete',
  'users.impersonate',
  'workspaces.view',
  'workspaces.manage',
  // Money
  'billing.view',
  'billing.manage',
  'payments.view',
  'refunds.manage',
  'plans.manage',
  'invoices.manage',
  'credits.manage',
  'coupons.manage',
  // Infrastructure
  'apps.view',
  'apps.manage',
  'deployments.view',
  'deployments.manage',
  'domains.view',
  'domains.manage',
  'databases.view',
  'databases.manage',
  'servers.view',
  'servers.manage',
  'resources.manage',
  'terminal.access',
  // Communication
  'email.view',
  'email.send',
  'smtp.manage',
  'announcements.manage',
  'support.view',
  'support.manage',
  'notifications.manage',
  // System + security
  'settings.view',
  'settings.manage',
  'features.manage',
  'audit.view',
  'logs.view',
  'errors.view',
  'errors.manage',
  'security.view',
  'security.manage',
  'apikeys.manage',
  'webhooks.manage',
  'uploads.manage',
  'export.data',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The scoped admin tiers this module adds on top of the historical ladder. */
export type AdminRole =
  | 'owner'
  | 'super_admin'
  | 'admin'
  | 'operations_admin'
  | 'billing_admin'
  | 'support_admin'
  | 'viewer';

/** Every `*.view` permission — the read-only role's whole grant. */
const VIEW_ONLY: Permission[] = PERMISSIONS.filter((p) => p.endsWith('.view')) as Permission[];

/**
 * Role → permissions. `owner` and `super_admin` are handled by `permissionsFor`
 * (they hold everything, including permissions added later — a matrix entry would
 * silently rot the day a new permission is introduced).
 */
const MATRIX: Record<Exclude<AdminRole, 'owner' | 'super_admin'>, Permission[]> = {
  // ADMIN — everything an operator does day to day. Managing *other admins* is
  // still refused by requireSuperAdmin on those specific endpoints.
  admin: [...PERMISSIONS] as Permission[],

  // OPERATIONS_ADMIN — runs the fleet. No money, no account lifecycle.
  operations_admin: [
    'users.view',
    'workspaces.view',
    'apps.view',
    'apps.manage',
    'deployments.view',
    'deployments.manage',
    'domains.view',
    'domains.manage',
    'databases.view',
    'databases.manage',
    'servers.view',
    'servers.manage',
    'resources.manage',
    'logs.view',
    'errors.view',
    'errors.manage',
    'audit.view',
    'settings.view',
    'security.view',
    'uploads.manage',
    'export.data',
    'billing.view',
  ],

  // BILLING_ADMIN — the money surface. Explicitly *not* servers: test §60.8
  // ("billing admin allowed payment view but denied server restart") is this line.
  billing_admin: [
    'users.view',
    'workspaces.view',
    'billing.view',
    'billing.manage',
    'payments.view',
    'refunds.manage',
    'plans.manage',
    'invoices.manage',
    'credits.manage',
    'coupons.manage',
    'email.view',
    'support.view',
    'audit.view',
    'settings.view',
    'export.data',
  ],

  // SUPPORT_ADMIN — answers customers. Reads context, mutates only tickets and
  // the notifications it sends; cannot suspend, refund or touch infrastructure.
  support_admin: [
    'users.view',
    'workspaces.view',
    'apps.view',
    'deployments.view',
    'domains.view',
    'databases.view',
    'billing.view',
    'payments.view',
    'support.view',
    'support.manage',
    'email.view',
    'notifications.manage',
    'logs.view',
    'errors.view',
    'audit.view',
    'settings.view',
  ],

  // READ_ONLY_ADMIN — sees everything, changes nothing.
  viewer: VIEW_ONLY,
};

/** Roles that reach the admin panel at all, weakest first. */
export const ADMIN_ROLES: AdminRole[] = [
  'viewer',
  'support_admin',
  'billing_admin',
  'operations_admin',
  'admin',
  'super_admin',
  'owner',
];

/** Human labels for the UI and audit rows. */
export const ROLE_LABELS: Record<AdminRole, string> = {
  owner: 'Owner',
  super_admin: 'Super Admin',
  admin: 'Admin',
  operations_admin: 'Operations Admin',
  billing_admin: 'Billing Admin',
  support_admin: 'Support Admin',
  viewer: 'Read-only Admin',
};

/** One-line description of what each tier is for, shown in the role picker. */
export const ROLE_BLURBS: Record<AdminRole, string> = {
  owner: 'The root account. Every permission, and immune to modification.',
  super_admin: 'Every permission, including managing other admin accounts.',
  admin: 'Full operator access. Cannot manage other admin accounts.',
  operations_admin: 'Servers, apps, deployments, domains and databases. No billing.',
  billing_admin: 'Plans, payments, refunds, invoices and credits. No infrastructure.',
  support_admin: 'Support tickets plus read-only customer context.',
  viewer: 'Read-only across the whole admin panel.',
};

/** True for roles that hold every permission, now and in future. */
function isAllPermissions(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'super_admin';
}

/** The permission set a role holds. Unknown / customer roles hold nothing. */
export function permissionsFor(role: string | null | undefined): Permission[] {
  if (isAllPermissions(role)) return [...PERMISSIONS] as Permission[];
  const entry = MATRIX[role as keyof typeof MATRIX];
  return entry ? [...entry] : [];
}

/** Does `role` hold `permission`? The single question every admin route asks. */
export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (isAllPermissions(role)) return true;
  const entry = MATRIX[role as keyof typeof MATRIX];
  return entry ? entry.includes(permission) : false;
}

/** True when the role is one of the admin tiers (i.e. may reach the panel). */
export function isAdminRole(role: string | null | undefined): boolean {
  return isAllPermissions(role) || role !== undefined && role !== null && role in MATRIX;
}

/**
 * Deny message that names the missing permission. Telling an operator *which*
 * grant they lack is what makes a 403 actionable; it leaks nothing, since the
 * permission vocabulary is documented.
 */
export function denyMessage(role: string | null | undefined, permission: Permission): string {
  const label = ROLE_LABELS[(role ?? 'viewer') as AdminRole] ?? 'Your account';
  return `${label} does not hold the "${permission}" permission.`;
}

/**
 * The permissions *this request* holds.
 *
 * Two kinds of caller reach the admin API: a signed-in operator, whose grant comes
 * from their live role, and a machine API key (§31), whose grant is the explicit
 * list stored on the key. A key authenticates as `admin` so it can pass the entry
 * gate, so reading permissions off the role here would silently promote every key
 * to a full administrator — the narrowing has to happen at this single point that
 * every gate below goes through.
 */
export function requestPermissions(req: AuthenticatedRequest): Permission[] {
  const key = req.adminKey;
  if (key) {
    const known = new Set<string>(PERMISSIONS);
    return key.permissions.filter((p): p is Permission => known.has(p));
  }
  return permissionsFor(req.user?.role);
}

/** Does this request hold `permission`? The one question every admin gate asks. */
export function requestHolds(req: AuthenticatedRequest, permission: Permission): boolean {
  if (req.adminKey) return requestPermissions(req).includes(permission);
  return hasPermission(req.user?.role, permission);
}

/** Deny message for either kind of caller, naming the key when it is one. */
export function denyMessageFor(req: AuthenticatedRequest, permission: Permission): string {
  if (req.adminKey) {
    return `API key "${req.adminKey.name}" does not hold the "${permission}" permission.`;
  }
  return denyMessage(req.user?.role, permission);
}

/**
 * Per-endpoint gate. Mount on any admin route: `router.post('/x', requirePermission('users.create'), h)`.
 * Runs after authMiddleware, so `req.user.role` is the live DB role (the JWT's
 * copy is never trusted for authorization decisions — see attachLiveRole).
 */
export function requirePermission(permission: Permission) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!requestHolds(req, permission)) {
      return res.status(403).json({
        error: denyMessageFor(req, permission),
        required_permission: permission,
      });
    }
    next();
  };
}

/** All-of gate, for endpoints that combine two concerns (e.g. refund + audit). */
export function requireAllPermissions(...permissions: Permission[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const missing = permissions.find((p) => !requestHolds(req, p));
    if (missing) {
      return res.status(403).json({
        error: denyMessageFor(req, missing),
        required_permission: missing,
      });
    }
    next();
  };
}

/**
 * Path → permission table for the legacy admin router.
 *
 * `routes/admin.ts` predates this module and mounts ~60 handlers behind one
 * coarse write gate. Rather than edit sixty signatures (and risk missing one, or
 * mis-scoping one in a rebase), the whole surface is gated here declaratively:
 * one ordered table, reviewable at a glance, applied by `adminPermissionGate`.
 *
 * Rules are tried in order and the FIRST match wins, so specific paths must come
 * before their prefixes. `method` matches exactly; `write: true` means "any
 * method other than GET/HEAD". A path with no rule falls through to
 * `FALLBACK_*`, which is deliberately strict rather than open.
 */
interface GateRule {
  /** Regex against the path *within* the admin router (leading slash kept). */
  test: RegExp;
  /** Permission required for a read (GET/HEAD). */
  read?: Permission;
  /** Permission required for a mutation. */
  write?: Permission;
}

const GATE_RULES: GateRule[] = [
  // Dashboards + health
  { test: /^\/overview\b/, read: 'settings.view' },
  { test: /^\/operations\b/, read: 'servers.view', write: 'servers.manage' },
  { test: /^\/servers\b/, read: 'servers.view', write: 'servers.manage' },
  { test: /^\/resources\b/, read: 'servers.view', write: 'resources.manage' },

  // Customers
  { test: /^\/users\/[^/]+\/(suspend|unsuspend)\b/, write: 'users.suspend' },
  { test: /^\/users\/[^/]+\/impersonate\b/, write: 'users.impersonate' },
  { test: /^\/users\/[^/]+\/billing\b/, read: 'billing.view', write: 'billing.manage' },
  { test: /^\/users\/[^/]+$/, read: 'users.view', write: 'users.edit' },
  { test: /^\/users\b/, read: 'users.view', write: 'users.create' },
  { test: /^\/workspaces\b/, read: 'workspaces.view', write: 'workspaces.manage' },

  // Money
  { test: /^\/plans\b/, read: 'billing.view', write: 'plans.manage' },
  { test: /^\/subscriptions\b/, read: 'billing.view', write: 'billing.manage' },
  { test: /^\/payments\b/, read: 'payments.view', write: 'billing.manage' },
  { test: /^\/refunds\b/, read: 'payments.view', write: 'refunds.manage' },
  { test: /^\/invoices\b/, read: 'billing.view', write: 'invoices.manage' },
  { test: /^\/credits\b/, read: 'billing.view', write: 'credits.manage' },
  { test: /^\/coupons\b/, read: 'billing.view', write: 'coupons.manage' },
  { test: /^\/cards\b/, read: 'billing.view', write: 'billing.manage' },
  { test: /^\/billing\b/, read: 'billing.view', write: 'billing.manage' },

  // Infrastructure
  { test: /^\/apps\b/, read: 'apps.view', write: 'apps.manage' },
  { test: /^\/deployments\b/, read: 'deployments.view', write: 'deployments.manage' },
  { test: /^\/domains\b/, read: 'domains.view', write: 'domains.manage' },
  { test: /^\/databases\b/, read: 'databases.view', write: 'databases.manage' },
  { test: /^\/uploads\b/, read: 'logs.view', write: 'uploads.manage' },

  // Communication
  { test: /^\/smtp\b/, read: 'settings.view', write: 'smtp.manage' },
  { test: /^\/email\/templates\b/, read: 'email.view', write: 'smtp.manage' },
  { test: /^\/email\/(test|send)\b/, write: 'email.send' },
  { test: /^\/email\b/, read: 'email.view', write: 'email.send' },
  { test: /^\/announcements\b/, read: 'email.view', write: 'announcements.manage' },
  { test: /^\/support\b/, read: 'support.view', write: 'support.manage' },
  { test: /^\/notifications\b/, read: 'email.view', write: 'notifications.manage' },

  // System + security
  { test: /^\/audit-logs\b/, read: 'audit.view' },
  { test: /^\/logs\b/, read: 'logs.view' },
  { test: /^\/errors\b/, read: 'errors.view', write: 'errors.manage' },
  { test: /^\/feature-flags\b/, read: 'settings.view', write: 'features.manage' },
  { test: /^\/security\b/, read: 'security.view', write: 'security.manage' },
  { test: /^\/sessions\b/, read: 'security.view', write: 'security.manage' },
  { test: /^\/api-keys\b/, read: 'security.view', write: 'apikeys.manage' },
  { test: /^\/webhooks\b/, read: 'settings.view', write: 'webhooks.manage' },
  { test: /^\/settings\b/, read: 'settings.view', write: 'settings.manage' },
];

/** Permission demanded by an unmatched read: the weakest thing every tier holds. */
const FALLBACK_READ: Permission = 'settings.view';
/** Permission demanded by an unmatched mutation: full-operator only, by design. */
const FALLBACK_WRITE: Permission = 'settings.manage';

/** Resolve `{method, path}` to the permission it needs. Exported for the tests. */
export function permissionForRequest(method: string, path: string): Permission {
  const isRead = method === 'GET' || method === 'HEAD';
  for (const rule of GATE_RULES) {
    if (!rule.test.test(path)) continue;
    const wanted = isRead ? rule.read : rule.write;
    // A rule that only names one side still owns the path: a table entry with
    // `read` but no `write` means writes here are not a thing this rule permits,
    // so they fall to the strict default rather than to the read permission.
    if (wanted) return wanted;
    return isRead ? FALLBACK_READ : FALLBACK_WRITE;
  }
  return isRead ? FALLBACK_READ : FALLBACK_WRITE;
}

/**
 * Table-driven gate for the whole legacy admin router. Mount once, before the
 * route definitions. Every request is checked; there is no unlisted-and-therefore-
 * allowed path.
 */
export function adminPermissionGate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  // `req.path` inside a mounted router is the sub-path (e.g. `/users/abc`).
  const permission = permissionForRequest(req.method, req.path);
  if (!requestHolds(req, permission)) {
    res.status(403).json({
      error: denyMessageFor(req, permission),
      required_permission: permission,
    });
    return;
  }
  next();
}

/**
 * Can `actorRole` grant `targetRole`? Thin alias over the ladder rule (grant
 * strictly below your own rank, `owner` never grantable) so callers in the admin
 * router don't have to know which module owns the ladder.
 */
export function canGrantAdminRole(actorRole: string | undefined, targetRole: string): boolean {
  return canAssignRole(actorRole, targetRole);
}

/** Roles assignable through the admin API. `owner` is bootstrap-only, always. */
export const GRANTABLE_ROLES: PlatformRole[] = ASSIGNABLE_ROLES;
