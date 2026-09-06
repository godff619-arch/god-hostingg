// Workspace layer: bootstrap, access control and plan capabilities.
//
// Hierarchy: User -> Workspace -> WorkspaceProject -> Environment -> Project
// (a deployable resource) -> Deployment. A user always has exactly one owned
// workspace; it is created on first access and legacy resources are adopted
// into its default project so nothing pre-existing disappears from the UI.

import crypto from 'crypto';
import prisma from './prisma.js';
import { AuthenticatedRequest, isAdmin } from './authMiddleware.js';
import { effectivePlanKey } from './billingState.js';
import { getSetting } from './settings.js';

/** Prefixed, URL-safe id in the Render style (`tea-9f3a21c4b7e0`). */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

export type PlanTier = 'hobby' | 'pro' | 'scale';

const TIER_ORDER: Record<PlanTier, number> = { hobby: 0, pro: 1, scale: 2 };

/** Feature key -> minimum tier that unlocks it. Single source for <PlanGate/>. */
export const FEATURE_TIERS = {
  webhooks: 'pro',
  dedicated_ips: 'pro',
  security: 'pro',
  audit_logs: 'pro',
  authentication: 'scale',
  hipaa: 'scale',
  build_pipeline_performance: 'pro',
} as const satisfies Record<string, PlanTier>;

export type FeatureKey = keyof typeof FEATURE_TIERS;

export function normalizeTier(planKey: string | null | undefined): PlanTier {
  const key = (planKey || '').toLowerCase();
  return key === 'pro' || key === 'scale' ? key : 'hobby';
}

/**
 * The tier a workspace is actually entitled to right now.
 *
 * Feature and quota checks must use this rather than `normalizeTier(ws.plan_key)`:
 * the raw column still reads `pro` after a subscription is canceled or its paid
 * period lapses — the admin panel and the renewal flow need to see what it *was* —
 * and honouring it there would hand out paid features for free. Spec §37: the plan
 * field alone is not the source of truth for billing.
 *
 * The billing columns are required, not optional: a caller whose `select` omits
 * `subscription_status` gets a compile error instead of a silently wrong tier.
 */
export function effectiveTier(ws: {
  plan_key: string;
  subscription_status: string;
  current_period_end?: Date | null;
}): PlanTier {
  return normalizeTier(effectivePlanKey(ws));
}

export function tierLabel(tier: PlanTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** True when `tier` is at or above the tier a feature requires. */
export function hasFeature(tier: PlanTier, feature: FeatureKey): boolean {
  return TIER_ORDER[tier] >= TIER_ORDER[FEATURE_TIERS[feature]];
}

/** Resolved feature map sent to the client so the UI never hardcodes gating. */
export function featureMap(tier: PlanTier): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const key of Object.keys(FEATURE_TIERS) as FeatureKey[]) {
    out[key] = hasFeature(tier, key);
  }
  return out;
}

/**
 * Monthly included allowances per tier. Config, not measurement — the usage
 * numerator always comes from real UsageRecord rows. NULL means unlimited.
 */
export const INCLUDED_USAGE: Record<
  PlanTier,
  {
    instance_hours: number | null;
    custom_domains: number | null;
    services: number | null;
    bandwidth_gb: number | null;
    pipeline_minutes: number | null;
  }
> = {
  hobby: {
    instance_hours: 750,
    custom_domains: 1,
    services: 1,
    bandwidth_gb: 100,
    pipeline_minutes: 500,
  },
  pro: {
    instance_hours: 1000,
    custom_domains: 25,
    services: 50,
    bandwidth_gb: 500,
    pipeline_minutes: 1000,
  },
  scale: {
    instance_hours: null,
    custom_domains: null,
    services: null,
    bandwidth_gb: 1000,
    pipeline_minutes: 2000,
  },
};

/** Current billing period key, `YYYY-MM`. */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Build-pipeline tiers offered on the Workspace Settings page. Config, not
 * measurement: rates are integer cents per 1,000 minutes so no currency is ever
 * floated, and `requires` names the feature the tier is gated behind — the client
 * renders whatever this says rather than hardcoding "Performance needs Pro".
 */
export const PIPELINE_TIERS = [
  {
    key: 'starter',
    name: 'Starter',
    rate_cents_per_1000_min: 500,
    cpu: 2,
    memory_gb: 8,
    free_minutes: 500,
    requires: null,
  },
  {
    key: 'performance',
    name: 'Performance',
    rate_cents_per_1000_min: 2500,
    cpu: 16,
    memory_gb: 64,
    free_minutes: 0,
    requires: 'build_pipeline_performance',
  },
] as const satisfies ReadonlyArray<{
  key: string;
  name: string;
  rate_cents_per_1000_min: number;
  cpu: number;
  memory_gb: number;
  free_minutes: number;
  requires: FeatureKey | null;
}>;

export type PipelineTierKey = (typeof PIPELINE_TIERS)[number]['key'];

/** Compliance documents offered for download. Absent files are reported honestly. */
export const COMPLIANCE_DOCUMENTS = [
  { key: 'soc2', name: 'SOC 2 Type II Report', description: 'Independent audit of security controls.' },
  { key: 'iso27001', name: 'ISO 27001 Certificate', description: 'Information security management certification.' },
  { key: 'gdpr', name: 'GDPR Data Processing Addendum', description: 'Terms for processing personal data.' },
] as const;

/**
 * The caller's workspace, created on first use. Also creates the default
 * project + Production environment and adopts any of the user's resources that
 * predate the workspace layer (legacy rows have workspace_project_id = NULL).
 */
export async function ensureWorkspace(userId: string) {
  const existing = await prisma.workspace.findFirst({
    where: { owner_id: userId },
    orderBy: { created_at: 'asc' },
  });
  if (existing) {
    await adoptOrphanResources(userId, existing.id);
    return existing;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, plan: { select: { key: true } } },
  });

  const workspace = await prisma.workspace.create({
    data: {
      id: newId('tea'),
      owner_id: userId,
      name: 'My Workspace',
      email: user?.email ?? null,
      plan_key: normalizeTier(user?.plan?.key),
    },
  });

  await prisma.workspaceMember.create({
    data: {
      workspace_id: workspace.id,
      user_id: userId,
      email: user?.email ?? '',
      role: 'admin',
      status: 'active',
      joined_at: new Date(),
    },
  });

  await adoptOrphanResources(userId, workspace.id);
  return workspace;
}

/** The workspace's default project (first by creation), created if absent. */
export async function ensureDefaultProject(workspaceId: string) {
  const existing = await prisma.workspaceProject.findFirst({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: 'asc' },
  });
  if (existing) return existing;
  return createWorkspaceProject(workspaceId, 'My project', null);
}

/**
 * Create a project group plus its initial environment. The initial environment is
 * "Production" unless the caller names another one, and is always flagged default
 * so every project has exactly one.
 */
export async function createWorkspaceProject(
  workspaceId: string,
  name: string,
  description: string | null,
  initialEnvironment?: string | null,
) {
  const project = await prisma.workspaceProject.create({
    data: { id: newId('prj'), workspace_id: workspaceId, name, description },
  });
  const environment = await prisma.environment.create({
    data: {
      id: newId('env'),
      workspace_project_id: project.id,
      name: initialEnvironment?.trim() || 'Production',
      is_default: true,
    },
  });
  return Object.assign(project, { initial_environment: environment });
}

/** A project group's default environment, created if the row is missing. */
export async function ensureDefaultEnvironment(workspaceProjectId: string) {
  const existing = await prisma.environment.findFirst({
    where: { workspace_project_id: workspaceProjectId },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });
  if (existing) return existing;
  return prisma.environment.create({
    data: {
      id: newId('env'),
      workspace_project_id: workspaceProjectId,
      name: 'Production',
      is_default: true,
    },
  });
}

/**
 * Move the user's pre-workspace resources into the default project so they stay
 * visible. Only touches rows that have no workspace project yet — never
 * reassigns a resource the user has already placed.
 */
async function adoptOrphanResources(userId: string, workspaceId: string): Promise<void> {
  const orphanCount = await prisma.project.count({
    where: { user_id: userId, workspace_project_id: null },
  });
  if (orphanCount === 0) return;

  const project = await ensureDefaultProject(workspaceId);
  const environment = await ensureDefaultEnvironment(project.id);
  await prisma.project.updateMany({
    where: { user_id: userId, workspace_project_id: null },
    data: { workspace_project_id: project.id, environment_id: environment.id },
  });
}

export interface WorkspaceAccessError {
  status: number;
  code: string;
  message: string;
}

function accessError(status: number, code: string, message: string): WorkspaceAccessError {
  return { status, code, message };
}

export function isWorkspaceAccessError(err: unknown): err is WorkspaceAccessError {
  return !!err && typeof err === 'object' && 'status' in err && 'code' in err;
}

/**
 * Workspace the caller targeted. The browser sends `?workspace=<tea-id>` (see the
 * frontend's `scoped()`); `workspaceId` in the query or body is accepted too so
 * older callers keep working. Absent means "the one I own", which
 * `ensureWorkspace` creates on first use. Membership is still checked by
 * `resolveWorkspace`, which 404s for outsiders, so a stale id fails closed.
 */
export function requestedWorkspaceId(req: AuthenticatedRequest): string | undefined {
  const candidates = [
    req.query?.workspace,
    req.query?.workspaceId,
    (req.body as { workspace?: unknown; workspaceId?: unknown } | undefined)?.workspace,
    (req.body as { workspace?: unknown; workspaceId?: unknown } | undefined)?.workspaceId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the workspace the caller may act on. Owners and active members pass;
 * admins may target any workspace. Everyone else gets 404 (not 403) so ids
 * cannot be probed by changing the URL.
 */
export async function resolveWorkspace(req: AuthenticatedRequest, workspaceId?: string) {
  const userId = req.user?.userId;
  if (!userId) throw accessError(401, 'UNAUTHENTICATED', 'Sign in required.');

  if (!workspaceId || workspaceId === 'current' || workspaceId === 'me') {
    return ensureWorkspace(userId);
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw accessError(404, 'NOT_FOUND', 'Workspace not found.');

  if (workspace.owner_id === userId || isAdmin(req)) return workspace;

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspace_id: workspace.id, user_id: userId, status: 'active' },
  });
  if (!membership) throw accessError(404, 'NOT_FOUND', 'Workspace not found.');
  return workspace;
}

/** The caller's role in a workspace: owner | admin | developer | viewer. */
export async function workspaceRole(
  req: AuthenticatedRequest,
  workspaceId: string,
): Promise<'owner' | 'admin' | 'developer' | 'viewer'> {
  const userId = req.user?.userId;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (workspace && userId && workspace.owner_id === userId) return 'owner';
  if (isAdmin(req)) return 'admin';
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspace_id: workspaceId, user_id: userId ?? undefined, status: 'active' },
  });
  const role = membership?.role;
  return role === 'admin' || role === 'developer' ? role : 'viewer';
}

/** Viewers may read but never mutate. Throws 403 for them. */
export async function assertWorkspaceWrite(
  req: AuthenticatedRequest,
  workspaceId: string,
): Promise<void> {
  const role = await workspaceRole(req, workspaceId);
  if (role === 'viewer') {
    throw accessError(403, 'FORBIDDEN', 'Your workspace role cannot make this change.');
  }
}

/** Load a project group the caller may access, with its workspace attached. */
export async function resolveWorkspaceProject(req: AuthenticatedRequest, projectId: string) {
  const project = await prisma.workspaceProject.findUnique({
    where: { id: projectId },
    include: { workspace: true },
  });
  if (!project) throw accessError(404, 'NOT_FOUND', 'Project not found.');
  // resolveWorkspace re-checks membership; it throws 404 for outsiders.
  await resolveWorkspace(req, project.workspace_id);
  return project;
}

/**
 * Configured host region, or NULL when the platform has none. The UI shows "—"
 * rather than inventing a region.
 */
export async function platformRegion(): Promise<string | null> {
  const value = await getSetting('platform_region');
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Translate a thrown workspace access error into a JSON response. */
export function sendWorkspaceError(res: import('express').Response, err: unknown): boolean {
  if (!isWorkspaceAccessError(err)) return false;
  res.status(err.status).json({
    success: false,
    error: { code: err.code, message: err.message },
  });
  return true;
}
