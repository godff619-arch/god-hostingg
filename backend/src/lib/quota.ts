/**
 * Server-side, DB-driven quota enforcement.
 *
 * Rules:
 * - Limits come from the user's effective Plan (DB), never from request bodies.
 * - Admin sessions (or users with no plan resolved to admin) => no limits.
 * - A NULL plan column means "unlimited" (explicit). Non-null Int is a hard cap.
 * - Current usage is computed LIVE (counts/sums), never trusting the Usage cache table.
 *
 * Checks throw an AccessError { status: 403, message } on breach so route handlers
 * can `sendAccessError(res, err)` uniformly.
 */
import prisma from './prisma.js';
import type { AccessError } from './authMiddleware.js';
import { notifyQuota } from './notify.js';
import { isFullAdmin } from './platformRoles.js';

export type EffectivePlan = {
  id: string;
  key: string;
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
} | null;

/**
 * Resolve the plan used for enforcement. Returns null for admins (unlimited).
 * Non-admins with no assigned plan fall back to the Free plan.
 */
export async function getEffectivePlan(userId: string | null | undefined): Promise<EffectivePlan> {
  if (!userId || userId === 'internal') return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { plan: true },
  });
  if (!user) return null;
  if (isFullAdmin(user.role)) return null; // owner/super_admin/admin => unlimited

  const plan = user.plan ?? (await prisma.plan.findUnique({ where: { key: 'free' } }));
  if (!plan) return null; // no plans seeded yet — fail open rather than lock users out

  // Per-user overrides: NULL = inherit the plan value; an integer = explicit cap.
  // Unlimited-per-user is expressed by assigning an unlimited plan (plan-level NULL),
  // never a sentinel integer here. `?? plan.x` keeps the plan value when override is null.
  return {
    id: plan.id,
    key: plan.key,
    ram_mb: user.ram_mb_override ?? plan.ram_mb,
    cpus_milli: user.cpus_milli_override ?? plan.cpus_milli,
    storage_mb: user.storage_mb_override ?? plan.storage_mb,
    max_apps: user.max_apps_override ?? plan.max_apps,
    max_domains: user.max_domains_override ?? plan.max_domains,
    max_backups: user.max_backups_override ?? plan.max_backups,
  };
}

function quotaError(message: string): AccessError {
  return { status: 403, message };
}

/**
 * Enforce max_apps before creating a project/database for a non-admin owner.
 * Admin (plan null) or NULL max_apps => allowed.
 */
export async function assertCanCreateApp(userId: string): Promise<void> {
  const plan = await getEffectivePlan(userId);
  if (!plan || plan.max_apps === null) return;

  const count = await prisma.project.count({ where: { user_id: userId } });
  if (count >= plan.max_apps) {
    const message = `App limit reached (${count}/${plan.max_apps}). Upgrade your plan to create more apps.`;
    // Fire-and-forget: the rejection below is the enforcement, the notice is
    // only so the user finds out without reading the failed request.
    void notifyQuota(userId, message);
    throw quotaError(message);
  }
}

/** Split a comma/whitespace-separated domain string into a normalized set. */
function parseDomains(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Enforce max_domains for a service domain change.
 * Computes the user's distinct hostnames across all their services, replaces the
 * ones on `serviceId` with `nextDomains`, and rejects if the total exceeds the cap.
 */
export async function assertDomainQuota(
  userId: string,
  serviceId: string,
  nextDomains: string[]
): Promise<void> {
  const plan = await getEffectivePlan(userId);
  if (!plan || plan.max_domains === null) return;

  const services = await prisma.service.findMany({
    where: { project: { user_id: userId } },
    select: { id: true, domain: true },
  });

  const set = new Set<string>();
  for (const svc of services) {
    if (svc.id === serviceId) continue; // this service's domains are being replaced
    for (const d of parseDomains(svc.domain)) set.add(d);
  }
  for (const d of nextDomains) set.add(d.trim().toLowerCase());

  if (set.size > plan.max_domains) {
    const message = `Domain limit reached (${set.size}/${plan.max_domains}). Upgrade your plan to add more domains.`;
    void notifyQuota(userId, message);
    throw quotaError(message);
  }
}

/**
 * Enforce storage_mb on persistent volume creation.
 *
 * KNOWN GAP: PersistentVolume has no size column and precise MB accounting requires
 * live `docker volume` measurement (unavailable synchronously / on the dev box).
 * The hook exists so the enforcement point is wired; it currently allows all creates.
 * A later phase adds either a size input or runtime measurement here.
 */
export async function assertStorageQuota(userId: string): Promise<void> {
  const plan = await getEffectivePlan(userId);
  if (!plan || plan.storage_mb === null) return;
  // TODO(storage-metering): measure the user's total volume MB and compare to plan.storage_mb.
  return;
}

/**
 * Translate a plan into deploy-time container resource limits.
 * NULL columns => undefined (no cgroup cap, current behavior preserved).
 */
export async function getDeployLimits(
  userId: string | null | undefined
): Promise<{ memLimit?: string; cpus?: number }> {
  const plan = await getEffectivePlan(userId);
  if (!plan) return {};
  return {
    memLimit: plan.ram_mb != null ? `${plan.ram_mb}m` : undefined,
    cpus: plan.cpus_milli != null ? plan.cpus_milli / 1000 : undefined,
  };
}
