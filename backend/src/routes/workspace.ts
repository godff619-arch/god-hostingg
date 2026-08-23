// Workspace API: the data behind the dashboard shell, the Overview project
// cards and the project overview page.
//
// Everything here is owner-scoped through resolveWorkspace(), which throws 404
// (never 403) for a workspace the caller has no membership in, so ids cannot be
// probed by editing the URL. Counts and health are computed from live rows —
// there are no placeholder resources.

import express, { Response } from 'express';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { syncProjectStatusFromContainers } from '../lib/projectStatusSync.js';
import {
  createWorkspaceProject,
  ensureDefaultEnvironment,
  ensureWorkspace,
  featureMap,
  newId,
  normalizeTier,
  platformRegion,
  requestedWorkspaceId,
  resolveWorkspace,
  resolveWorkspaceProject,
  sendWorkspaceError,
  tierLabel,
  assertWorkspaceWrite,
  workspaceRole,
  COMPLIANCE_DOCUMENTS,
  FEATURE_TIERS,
  hasFeature,
  PIPELINE_TIERS,
} from '../lib/workspace.js';
import type { FeatureKey, PlanTier } from '../lib/workspace.js';

const router = express.Router();

const MAX_NAME = 60;
const MAX_DESCRIPTION = 280;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Trim + length-check a required text field. Returns null when invalid. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/** First letter of the workspace name — the avatar fallback (no image upload). */
function initialOf(name: string): string {
  return (name.trim()[0] || 'W').toUpperCase();
}


/** Human runtime label. Derived from stored fields only, never guessed. */
const DB_ENGINE_LABELS: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

function runtimeLabel(p: {
  project_type: string | null;
  db_engine: string | null;
  build_type: string;
}): string {
  if (p.project_type === 'database') {
    return (p.db_engine && DB_ENGINE_LABELS[p.db_engine]) || 'Database';
  }
  if (p.build_type === 'dockerfile') return 'Docker';
  if (p.build_type === 'railpack') return 'Railpack';
  return 'Auto';
}

/** Resource status vocabulary shown in the project overview table. */
type ResourceState = 'deployed' | 'deploying' | 'building' | 'failed' | 'suspended' | 'pending';

function resourceState(status: string | null): ResourceState {
  switch (status) {
    case 'running':
      return 'deployed';
    case 'building':
      return 'building';
    case 'error':
      return 'failed';
    case 'degraded':
      return 'deploying';
    case 'stopped':
      return 'suspended';
    default:
      return 'pending';
  }
}

/** Card badge state for a project group. `empty` never claims health. */
type ProjectHealth = 'healthy' | 'warning' | 'error' | 'deploying' | 'empty';

function projectHealth(states: ResourceState[]): ProjectHealth {
  if (states.length === 0) return 'empty';
  if (states.some((s) => s === 'building' || s === 'deploying')) return 'deploying';
  if (states.some((s) => s === 'failed')) return 'error';
  if (states.every((s) => s === 'deployed')) return 'healthy';
  return 'warning';
}

/** A row in the project overview resource table. */
interface ResourceRow {
  id: string;
  environment_id: string | null;
  name: string;
  type: 'service' | 'database';
  state: ResourceState;
  runtime: string;
  region: string | null;
  domain: string | null;
  service_count: number;
  updated_at: string | null;
  last_deploy: {
    status: string | null;
    created_at: Date | null;
    finished_at: Date | null;
  } | null;
}

/** Shared workspace payload: identity + plan + resolved feature flags. */
async function workspacePayload(req: AuthenticatedRequest, workspaceId?: string) {
  const workspace = await resolveWorkspace(req, workspaceId);
  const tier = normalizeTier(workspace.plan_key);
  const role = await workspaceRole(req, workspace.id);
  const owner = await prisma.user.findUnique({
    where: { id: workspace.owner_id },
    select: { email: true, name: true },
  });
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      email: workspace.email || owner?.email || null,
      avatar: workspace.avatar,
      initial: initialOf(workspace.name),
      created_at: workspace.created_at,
      plan: { key: tier, label: tierLabel(tier) },
      features: featureMap(tier),
      role,
    },
    owner: owner ? { name: owner.name, email: owner.email } : null,
  };
}

// GET /api/workspace — shell context (workspace selector, plan gate, avatar).
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payload = await workspacePayload(req, requestedWorkspaceId(req));
    const [projects, resources, members] = await Promise.all([
      prisma.workspaceProject.count({ where: { workspace_id: payload.workspace.id } }),
      prisma.project.count({
        where: { workspace_project: { workspace_id: payload.workspace.id } },
      }),
      prisma.workspaceMember.count({ where: { workspace_id: payload.workspace.id } }),
    ]);
    res.json({ ...payload, counts: { projects, resources, members } });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] context failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load workspace.');
  }
});

// GET /api/workspace/list — every workspace the caller can open (switcher).
router.get('/list', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    // Guarantees at least one row for a brand-new account.
    const own = await ensureWorkspace(userId);
    const memberships = await prisma.workspaceMember.findMany({
      where: { user_id: userId, status: 'active' },
      select: { workspace_id: true, role: true },
    });
    const ids = new Set([own.id, ...memberships.map((m) => m.workspace_id)]);
    const rows = await prisma.workspace.findMany({
      where: { id: { in: [...ids] } },
      orderBy: { created_at: 'asc' },
    });
    const roleFor = new Map(memberships.map((m) => [m.workspace_id, m.role]));
    res.json({
      workspaces: rows.map((w) => {
        const tier = normalizeTier(w.plan_key);
        return {
          id: w.id,
          name: w.name,
          initial: initialOf(w.name),
          avatar: w.avatar,
          plan: { key: tier, label: tierLabel(tier) },
          role: w.owner_id === userId ? 'owner' : roleFor.get(w.id) || 'viewer',
          is_owner: w.owner_id === userId,
        };
      }),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load workspaces.');
  }
});

// POST /api/workspace — create another workspace owned by the caller.
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const name = cleanText(req.body?.name, MAX_NAME);
    if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);

    // Inherit the account's plan; a new workspace never silently self-upgrades.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, plan: { select: { key: true } } },
    });
    const tier = normalizeTier(user?.plan?.key);
    const workspace = await prisma.workspace.create({
      data: {
        id: newId('tea'),
        owner_id: userId,
        name,
        email: user?.email ?? null,
        plan_key: tier,
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
    await createWorkspaceProject(workspace.id, 'My project', null);
    await writeAudit(req, 'workspace.create', `workspace:${workspace.id}`, { name });

    res.status(201).json({
      success: true,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        initial: initialOf(workspace.name),
        avatar: null,
        plan: { key: tier, label: tierLabel(tier) },
        role: 'owner',
        is_owner: true,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create workspace.');
  }
});

// PATCH /api/workspace — rename the workspace / change its billing email.
router.patch('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const data: { name?: string; email?: string | null } = {};
    if (req.body.name !== undefined) {
      const name = cleanText(req.body.name, MAX_NAME);
      if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);
      data.name = name;
    }
    if (req.body.email !== undefined) {
      const raw = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return fail(res, 400, 'INVALID_EMAIL', 'Enter a valid email address.');
      }
      data.email = raw || null;
    }
    if (Object.keys(data).length === 0) {
      return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');
    }

    const updated = await prisma.workspace.update({ where: { id: workspace.id }, data });
    await writeAudit(req, 'workspace.update', `workspace:${workspace.id}`, Object.keys(data));
    res.json({
      success: true,
      workspace: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        initial: initialOf(updated.name),
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update workspace.');
  }
});

// GET /api/workspace/projects — Overview cards with live aggregated health.
router.get('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const projects = await prisma.workspaceProject.findMany({
      where: { workspace_id: workspace.id },
      orderBy: { created_at: 'asc' },
      include: {
        environments: { select: { id: true } },
        resources: {
          select: { id: true, status: true, container_name: true, project_type: true },
        },
      },
    });

    const resourceIds = projects.flatMap((project) => project.resources.map((r) => r.id));
    // One grouped query for every card's "last deployed" line, instead of a
    // per-project round trip.
    const lastDeploys = resourceIds.length
      ? await prisma.deployment.groupBy({
          by: ['project_id'],
          where: { project_id: { in: resourceIds } },
          _max: { created_at: true },
        })
      : [];
    const lastDeployByResource = new Map(
      lastDeploys.map((row) => [row.project_id, row._max.created_at ?? null]),
    );

    const cards = [];
    for (const project of projects) {
      const states: ResourceState[] = [];
      let lastDeployedAt: Date | null = null;
      for (const resource of project.resources) {
        // Re-read container truth for anything that has been deployed, so a
        // card never reports "up" for a container that has since died.
        let status = resource.status;
        if (resource.container_name && status !== 'building') {
          status = await syncProjectStatusFromContainers(resource.id);
        }
        states.push(resourceState(status));
        const deployedAt = lastDeployByResource.get(resource.id) ?? null;
        if (deployedAt && (!lastDeployedAt || deployedAt > lastDeployedAt)) {
          lastDeployedAt = deployedAt;
        }
      }
      cards.push({
        id: project.id,
        name: project.name,
        description: project.description,
        created_at: project.created_at,
        updated_at: project.updated_at,
        last_deployed_at: lastDeployedAt,
        counts: {
          resources: project.resources.length,
          services: project.resources.filter((r) => r.project_type !== 'database').length,
          databases: project.resources.filter((r) => r.project_type === 'database').length,
          environments: project.environments.length,
        },
        // Measured breakdown behind the card badge and the Projects page filter
        // counts — never a hardcoded status.
        states: {
          deployed: states.filter((s) => s === 'deployed').length,
          building: states.filter((s) => s === 'building').length,
          deploying: states.filter((s) => s === 'deploying').length,
          failed: states.filter((s) => s === 'failed').length,
          suspended: states.filter((s) => s === 'suspended').length,
          pending: states.filter((s) => s === 'pending').length,
        },
        health: projectHealth(states),
      });
    }

    res.json({ projects: cards });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] projects failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load projects.');
  }
});

// POST /api/workspace/projects — create an empty project group (+ Production).
router.post('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const name = cleanText(req.body?.name, MAX_NAME);
    if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);

    const description =
      req.body?.description === undefined || req.body?.description === null
        ? null
        : cleanText(req.body.description, MAX_DESCRIPTION);
    if (req.body?.description && description === null) {
      return fail(res, 400, 'INVALID_DESCRIPTION', `Description must be ≤${MAX_DESCRIPTION} characters.`);
    }

    // "Initial environment" from the create dialog; Production when omitted.
    const initialEnvironment = req.body?.environment
      ? cleanText(req.body.environment, 40)
      : null;
    if (req.body?.environment && !initialEnvironment) {
      return fail(res, 400, 'INVALID_NAME', 'Environment name must be 1–40 characters.');
    }

    const project = await createWorkspaceProject(
      workspace.id,
      name,
      description,
      initialEnvironment,
    );
    await writeAudit(req, 'workspace.project.create', `workspace_project:${project.id}`, {
      name,
      environment: project.initial_environment.name,
    });
    res.status(201).json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        created_at: project.created_at,
        updated_at: project.updated_at,
        last_deployed_at: null,
        counts: { resources: 0, services: 0, databases: 0, environments: 1 },
        // A brand-new project has nothing in it: measured zeroes, not placeholders.
        states: {
          deployed: 0,
          building: 0,
          deploying: 0,
          failed: 0,
          suspended: 0,
          pending: 0,
        },
        health: 'empty',
      },
      environment: {
        id: project.initial_environment.id,
        name: project.initial_environment.name,
        is_default: project.initial_environment.is_default,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] project create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create the project.');
  }
});

// GET /api/workspace/projects/:id — project overview (environments + resources).
router.get('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const project = await resolveWorkspaceProject(req, req.params.id);
    await ensureDefaultEnvironment(project.id);

    const [environments, resources, region] = await Promise.all([
      prisma.environment.findMany({
        where: { workspace_project_id: project.id },
        orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
        // Drives the dynamic `Env Groups (X)` tab — a real link count, never a
        // placeholder.
        include: { _count: { select: { env_group_links: true } } },
      }),
      prisma.project.findMany({
        where: { workspace_project_id: project.id },
        orderBy: { created_at: 'asc' },
        include: {
          services: { select: { id: true, name: true, status: true } },
          deployments: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { status: true, created_at: true, finished_at: true },
          },
        },
      }),
      platformRegion(),
    ]);

    const rows: ResourceRow[] = [];
    for (const resource of resources) {
      let status = resource.status;
      if (resource.container_name && status !== 'building') {
        status = await syncProjectStatusFromContainers(resource.id);
      }
      const last = resource.deployments[0];
      rows.push({
        id: resource.id,
        environment_id: resource.environment_id,
        name: resource.name,
        type: resource.project_type === 'database' ? 'database' : 'service',
        state: resourceState(status),
        runtime: runtimeLabel(resource),
        region: resource.region ?? region,
        domain: resource.domain,
        service_count: resource.services.length,
        updated_at: (resource.updated_at ?? resource.created_at)?.toISOString() ?? null,
        last_deploy: last
          ? {
              status: last.status,
              created_at: last.created_at,
              finished_at: last.finished_at,
            }
          : null,
      });
    }

    res.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      workspace: { id: project.workspace.id, name: project.workspace.name },
      environments: environments.map((env) => ({
        id: env.id,
        name: env.name,
        is_default: env.is_default,
        counts: {
          all: rows.filter((r) => r.environment_id === env.id).length,
          services: rows.filter((r) => r.environment_id === env.id && r.type === 'service').length,
          databases: rows.filter((r) => r.environment_id === env.id && r.type === 'database').length,
          env_groups: env._count.env_group_links,
        },
      })),
      resources: rows,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] project overview failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load the project.');
  }
});

// PATCH /api/workspace/projects/:id — inline rename / description edit.
router.patch('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const project = await resolveWorkspaceProject(req, req.params.id);
    await assertWorkspaceWrite(req, project.workspace_id);

    const data: { name?: string; description?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = cleanText(req.body.name, MAX_NAME);
      if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);
      data.name = name;
    }
    if (req.body?.description !== undefined) {
      const raw = typeof req.body.description === 'string' ? req.body.description.trim() : '';
      if (raw.length > MAX_DESCRIPTION) {
        return fail(res, 400, 'INVALID_DESCRIPTION', `Description must be ≤${MAX_DESCRIPTION} characters.`);
      }
      data.description = raw || null;
    }
    if (Object.keys(data).length === 0) return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');

    const updated = await prisma.workspaceProject.update({ where: { id: project.id }, data });
    await writeAudit(req, 'workspace.project.update', `workspace_project:${project.id}`, Object.keys(data));
    res.json({
      success: true,
      project: { id: updated.id, name: updated.name, description: updated.description },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] project update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the project.');
  }
});

// DELETE /api/workspace/projects/:id — refuses while resources still live in it.
router.delete('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const project = await resolveWorkspaceProject(req, req.params.id);
    await assertWorkspaceWrite(req, project.workspace_id);

    const resourceCount = await prisma.project.count({
      where: { workspace_project_id: project.id },
    });
    if (resourceCount > 0) {
      return fail(
        res,
        409,
        'NOT_EMPTY',
        `Delete or move the ${resourceCount} resource${resourceCount === 1 ? '' : 's'} in this project first.`,
      );
    }

    const remaining = await prisma.workspaceProject.count({
      where: { workspace_id: project.workspace_id },
    });
    if (remaining <= 1) {
      return fail(res, 409, 'LAST_PROJECT', 'A workspace must keep at least one project.');
    }

    await prisma.workspaceProject.delete({ where: { id: project.id } });
    await writeAudit(req, 'workspace.project.delete', `workspace_project:${project.id}`, {
      name: project.name,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] project delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the project.');
  }
});

/**
 * GET /api/workspace/projects/:id/environments — cheap navigation payload for the
 * project-scoped sidebar rail and breadcrumbs. Deliberately does NOT return the
 * resource rows (that is the overview endpoint's job) so opening a service page
 * does not re-fetch every service in the project.
 */
router.get('/projects/:id/environments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const project = await resolveWorkspaceProject(req, req.params.id);
    await ensureDefaultEnvironment(project.id);

    const environments = await prisma.environment.findMany({
      where: { workspace_project_id: project.id },
      orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
      select: { id: true, name: true, is_default: true },
    });

    res.json({
      project: { id: project.id, name: project.name },
      environments,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] environment list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load environments.');
  }
});

// POST /api/workspace/projects/:id/environments — "+ Add environment".
router.post('/projects/:id/environments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const project = await resolveWorkspaceProject(req, req.params.id);
    await assertWorkspaceWrite(req, project.workspace_id);

    const name = cleanText(req.body?.name, 40);
    if (!name) return fail(res, 400, 'INVALID_NAME', 'Environment name must be 1–40 characters.');

    const clash = await prisma.environment.findFirst({
      where: { workspace_project_id: project.id, name },
    });
    if (clash) return fail(res, 409, 'DUPLICATE', `“${name}” already exists in this project.`);

    const env = await prisma.environment.create({
      data: { id: newId('env'), workspace_project_id: project.id, name },
    });
    await writeAudit(req, 'workspace.environment.create', `environment:${env.id}`, { name });
    res.status(201).json({
      success: true,
      environment: {
        id: env.id,
        name: env.name,
        is_default: env.is_default,
        // A just-created environment has nothing in it yet, including env-group
        // links, so these zeroes are measured facts rather than placeholders.
        counts: { all: 0, services: 0, databases: 0, env_groups: 0 },
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] environment create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create the environment.');
  }
});

// DELETE /api/workspace/environments/:id — refuses while resources live in it.
router.delete('/environments/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const env = await prisma.environment.findUnique({
      where: { id: req.params.id },
      include: { workspace_project: true },
    });
    if (!env) return fail(res, 404, 'NOT_FOUND', 'Environment not found.');
    await resolveWorkspace(req, env.workspace_project.workspace_id);
    await assertWorkspaceWrite(req, env.workspace_project.workspace_id);

    if (env.is_default) {
      return fail(res, 409, 'DEFAULT_ENVIRONMENT', 'The default environment cannot be deleted.');
    }
    const used = await prisma.project.count({ where: { environment_id: env.id } });
    if (used > 0) {
      return fail(res, 409, 'NOT_EMPTY', 'Move or delete this environment’s resources first.');
    }

    await prisma.environment.delete({ where: { id: env.id } });
    await writeAudit(req, 'workspace.environment.delete', `environment:${env.id}`, {
      name: env.name,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] environment delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the environment.');
  }
});

// GET /api/workspace/members — team list for Settings and the invite modal.
router.get('/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const members = await prisma.workspaceMember.findMany({
      where: { workspace_id: workspace.id },
      orderBy: { invited_at: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        name: m.user?.name ?? null,
        role: m.role,
        status: m.status,
        is_owner: m.user_id === workspace.owner_id,
        invited_at: m.invited_at,
        joined_at: m.joined_at,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] members failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load team members.');
  }
});

// POST /api/workspace/members — invite by email (one row per email, idempotent).
router.post('/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const emails: string[] = Array.isArray(req.body?.emails)
      ? req.body.emails
      : [req.body?.email];
    const cleaned = emails
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);

    if (cleaned.length === 0) return fail(res, 400, 'NO_EMAILS', 'Add at least one email address.');
    const invalid = cleaned.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (invalid.length) {
      return fail(res, 400, 'INVALID_EMAIL', `Not a valid email: ${invalid.join(', ')}`);
    }

    const role = ['admin', 'developer', 'viewer'].includes(req.body?.role)
      ? req.body.role
      : 'developer';

    // Which rows already exist decides the "N invited, M already on the team"
    // count. Reading it from the post-upsert status would be wrong: a pending
    // invite is still `invited`, so re-inviting someone would look like a new seat.
    const already = new Set(
      (
        await prisma.workspaceMember.findMany({
          where: { workspace_id: workspace.id, email: { in: cleaned } },
          select: { email: true },
        })
      ).map((m) => m.email),
    );

    let invited = 0;
    for (const email of cleaned) {
      const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      await prisma.workspaceMember.upsert({
        where: { workspace_id_email: { workspace_id: workspace.id, email } },
        update: {},
        create: {
          workspace_id: workspace.id,
          email,
          role,
          user_id: existingUser?.id ?? null,
          status: 'invited',
        },
      });
      if (!already.has(email)) invited += 1;
    }

    await writeAudit(req, 'workspace.member.invite', `workspace:${workspace.id}`, {
      emails: cleaned,
      role,
    });
    res.status(201).json({ success: true, invited, total: cleaned.length });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] invite failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not send the invitations.');
  }
});

// PATCH /api/workspace/members/:id — change a member's role (never the owner's).
router.patch('/members/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const member = await prisma.workspaceMember.findUnique({ where: { id: req.params.id } });
    if (!member) return fail(res, 404, 'NOT_FOUND', 'Member not found.');
    const workspace = await resolveWorkspace(req, member.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    if (member.user_id && member.user_id === workspace.owner_id) {
      return fail(res, 409, 'OWNER', 'The workspace owner’s role cannot be changed.');
    }
    if (!['admin', 'developer', 'viewer'].includes(req.body?.role)) {
      return fail(res, 400, 'INVALID_ROLE', 'Role must be admin, developer or viewer.');
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role: req.body.role },
    });
    await writeAudit(req, 'workspace.member.role', `workspace_member:${member.id}`, {
      role: req.body.role,
    });
    res.json({ success: true, member: { id: updated.id, role: updated.role } });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] member update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the member.');
  }
});

// DELETE /api/workspace/members/:id — remove a member (owner is protected).
router.delete('/members/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const member = await prisma.workspaceMember.findUnique({ where: { id: req.params.id } });
    if (!member) return fail(res, 404, 'NOT_FOUND', 'Member not found.');
    const workspace = await resolveWorkspace(req, member.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    if (member.user_id && member.user_id === workspace.owner_id) {
      return fail(res, 409, 'OWNER', 'The workspace owner cannot be removed.');
    }

    await prisma.workspaceMember.delete({ where: { id: member.id } });
    await writeAudit(req, 'workspace.member.remove', `workspace_member:${member.id}`, {
      email: member.email,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] member delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not remove the member.');
  }
});

// ------------------------------------------------------------ workspace settings

/**
 * The settings row for a workspace, created on first read. Defaults live in the
 * schema, so an untouched workspace answers with the documented values instead of
 * the client having to invent them.
 */
async function ensureSettings(workspaceId: string) {
  const existing = await prisma.workspaceSettings.findUnique({
    where: { workspace_id: workspaceId },
  });
  if (existing) return existing;
  return prisma.workspaceSettings.create({ data: { workspace_id: workspaceId } });
}

type SettingsRow = Awaited<ReturnType<typeof ensureSettings>>;

/** Wire shape. No secret ever lives in this row, so every field is returned. */
function shapeSettings(row: SettingsRow) {
  return {
    pipeline_tier: row.pipeline_tier,
    pipeline_spend_limit_cents: row.pipeline_spend_limit_cents,
    deploy_policy: row.deploy_policy,
    require_2fa: row.require_2fa,
    session_timeout_minutes: row.session_timeout_minutes,
    ip_allowlist: row.ip_allowlist,
    security_alerts: row.security_alerts,
    saml_enabled: row.saml_enabled,
    saml_metadata_url: row.saml_metadata_url,
    scim_enabled: row.scim_enabled,
    hipaa_enabled: row.hipaa_enabled,
    hipaa_accepted_at: row.hipaa_accepted_at,
    updated_at: row.updated_at,
  };
}

/** 403 PLAN_LOCKED carries the tier the client should offer to upgrade to. */
function planLocked(res: Response, feature: FeatureKey, current: PlanTier): void {
  res.status(403).json({
    success: false,
    error: {
      code: 'PLAN_LOCKED',
      message: `Your plan does not include this setting.`,
      required_plan: FEATURE_TIERS[feature] as PlanTier,
      current_plan: current,
    },
  });
}

/** One allow-list entry per line: an IPv4/IPv6 address, optionally with a prefix. */
const IP_ENTRY = /^[0-9a-f.:]{2,45}(\/\d{1,3})?$/i;

function cleanAllowlist(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const entries = value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length > 50) return undefined;
  if (entries.some((entry) => !IP_ENTRY.test(entry))) return undefined;
  return entries.join('\n');
}

// GET /api/workspace/settings — everything the Workspace Settings page renders.
router.get('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = normalizeTier(workspace.plan_key);
    const [settings, role, memberCount, resourceCount, ownedCount] = await Promise.all([
      ensureSettings(workspace.id),
      workspaceRole(req, workspace.id),
      prisma.workspaceMember.count({ where: { workspace_id: workspace.id } }),
      // The two counts DELETE / itself enforces, so the page can explain why the
      // button is disabled instead of arming it and failing on submit.
      prisma.project.count({ where: { workspace_project: { workspace_id: workspace.id } } }),
      prisma.workspace.count({ where: { owner_id: workspace.owner_id } }),
    ]);

    const deleteBlock =
      role !== 'owner'
        ? 'not_owner'
        : resourceCount > 0
          ? 'not_empty'
          : ownedCount <= 1
            ? 'last_workspace'
            : null;

    res.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        // NULL email falls back to the owner's account email downstream, so the
        // page shows the placeholder rather than a wrong address.
        email: workspace.email,
        avatar: workspace.avatar,
        initial: initialOf(workspace.name),
        created_at: workspace.created_at,
      },
      plan: { key: tier, label: tierLabel(tier) },
      features: featureMap(tier),
      feature_tiers: FEATURE_TIERS,
      role,
      // Armed only when the DELETE endpoint would actually accept the request;
      // `delete_block` names the reason so the UI never invents one.
      can_delete: deleteBlock === null,
      delete_block: deleteBlock,
      resource_count: resourceCount,
      member_count: memberCount,
      pipeline_tiers: PIPELINE_TIERS,
      documents: COMPLIANCE_DOCUMENTS,
      settings: shapeSettings(settings),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] settings failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load workspace settings.');
  }
});

// PATCH /api/workspace/settings — partial update. Every gated group is checked
// against the workspace plan here; the client's gating is cosmetic.
router.patch('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);
    const tier = normalizeTier(workspace.plan_key);
    await ensureSettings(workspace.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    // --- build pipeline -----------------------------------------------------
    if (body.pipeline_tier !== undefined) {
      const wanted = PIPELINE_TIERS.find((t) => t.key === body.pipeline_tier);
      if (!wanted) return fail(res, 400, 'INVALID_TIER', 'Unknown build pipeline tier.');
      if (wanted.requires && !hasFeature(tier, wanted.requires)) {
        return planLocked(res, wanted.requires, tier);
      }
      data.pipeline_tier = wanted.key;
    }
    if (body.pipeline_spend_limit_cents !== undefined) {
      const raw = body.pipeline_spend_limit_cents;
      if (raw === null) {
        data.pipeline_spend_limit_cents = null;
      } else if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 0 ||
        raw > 100_000_00
      ) {
        return fail(res, 400, 'INVALID_LIMIT', 'Spend limit must be 0–100000 in whole dollars.');
      } else {
        data.pipeline_spend_limit_cents = raw;
      }
    }

    // --- deploy policy ------------------------------------------------------
    if (body.deploy_policy !== undefined) {
      if (body.deploy_policy !== 'override' && body.deploy_policy !== 'wait') {
        return fail(res, 400, 'INVALID_POLICY', 'Deploy policy must be override or wait.');
      }
      data.deploy_policy = body.deploy_policy;
    }

    // --- security (Pro) -----------------------------------------------------
    const securityKeys = ['require_2fa', 'session_timeout_minutes', 'ip_allowlist', 'security_alerts'];
    if (securityKeys.some((key) => body[key] !== undefined)) {
      if (!hasFeature(tier, 'security')) return planLocked(res, 'security', tier);
      if (body.require_2fa !== undefined) {
        if (typeof body.require_2fa !== 'boolean') {
          return fail(res, 400, 'INVALID_VALUE', 'require_2fa must be a boolean.');
        }
        data.require_2fa = body.require_2fa;
      }
      if (body.security_alerts !== undefined) {
        if (typeof body.security_alerts !== 'boolean') {
          return fail(res, 400, 'INVALID_VALUE', 'security_alerts must be a boolean.');
        }
        data.security_alerts = body.security_alerts;
      }
      if (body.session_timeout_minutes !== undefined) {
        const raw = body.session_timeout_minutes;
        if (raw === null) {
          data.session_timeout_minutes = null;
        } else if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 5 || raw > 43200) {
          return fail(res, 400, 'INVALID_TIMEOUT', 'Session timeout must be 5–43200 minutes.');
        } else {
          data.session_timeout_minutes = raw;
        }
      }
      if (body.ip_allowlist !== undefined) {
        const list = cleanAllowlist(body.ip_allowlist);
        if (list === undefined) {
          return fail(res, 400, 'INVALID_IP', 'Each line must be an IP address or CIDR range.');
        }
        data.ip_allowlist = list;
      }
    }

    // --- authentication (Scale) ---------------------------------------------
    const authKeys = ['saml_enabled', 'saml_metadata_url', 'scim_enabled'];
    if (authKeys.some((key) => body[key] !== undefined)) {
      if (!hasFeature(tier, 'authentication')) return planLocked(res, 'authentication', tier);
      if (body.saml_metadata_url !== undefined) {
        if (body.saml_metadata_url === null || body.saml_metadata_url === '') {
          data.saml_metadata_url = null;
        } else if (
          typeof body.saml_metadata_url !== 'string' ||
          !/^https:\/\/\S+$/i.test(body.saml_metadata_url.trim())
        ) {
          return fail(res, 400, 'INVALID_URL', 'Metadata URL must be an https:// URL.');
        } else {
          data.saml_metadata_url = body.saml_metadata_url.trim();
        }
      }
      if (body.saml_enabled !== undefined) {
        if (typeof body.saml_enabled !== 'boolean') {
          return fail(res, 400, 'INVALID_VALUE', 'saml_enabled must be a boolean.');
        }
        // Turning SSO on without an IdP would lock the workspace out of sign-in.
        const url = (data.saml_metadata_url ?? undefined) as string | null | undefined;
        const current = await prisma.workspaceSettings.findUnique({
          where: { workspace_id: workspace.id },
          select: { saml_metadata_url: true },
        });
        const effective = url !== undefined ? url : current?.saml_metadata_url ?? null;
        if (body.saml_enabled && !effective) {
          return fail(res, 400, 'NO_METADATA', 'Add the IdP metadata URL before enabling SSO.');
        }
        data.saml_enabled = body.saml_enabled;
      }
      if (body.scim_enabled !== undefined) {
        if (typeof body.scim_enabled !== 'boolean') {
          return fail(res, 400, 'INVALID_VALUE', 'scim_enabled must be a boolean.');
        }
        data.scim_enabled = body.scim_enabled;
      }
    }

    // --- HIPAA (Scale) ------------------------------------------------------
    if (body.hipaa_enabled !== undefined) {
      if (!hasFeature(tier, 'hipaa')) return planLocked(res, 'hipaa', tier);
      if (typeof body.hipaa_enabled !== 'boolean') {
        return fail(res, 400, 'INVALID_VALUE', 'hipaa_enabled must be a boolean.');
      }
      // The UI requires a typed confirmation; the server records when it happened.
      data.hipaa_enabled = body.hipaa_enabled;
      data.hipaa_accepted_at = body.hipaa_enabled ? new Date() : null;
    }

    if (Object.keys(data).length === 0) {
      return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');
    }

    const saved = await prisma.workspaceSettings.update({
      where: { workspace_id: workspace.id },
      data,
    });
    // Metadata is the changed keys, never the values — an allow-list or IdP URL
    // does not belong in an audit row.
    await writeAudit(req, 'workspace.settings.update', `workspace:${workspace.id}`, Object.keys(data));
    res.json({ success: true, settings: shapeSettings(saved) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] settings update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save workspace settings.');
  }
});

/**
 * Audit rows visible to a workspace. `AuditLog` records the actor, not a
 * workspace, so the set is "anything done by a person in this workspace, plus
 * anything recorded against the workspace itself". Rows are never editable and
 * never deleted from here.
 */
async function auditWhere(workspaceId: string, ownerId: string) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId, user_id: { not: null } },
    select: { user_id: true },
  });
  const actorIds = [ownerId, ...members.map((m) => m.user_id!).filter(Boolean)];
  return {
    OR: [{ user_id: { in: actorIds } }, { resource: `workspace:${workspaceId}` }],
  };
}

/**
 * Audits are written after a mutation succeeds, so a row means the action went
 * through. Explicit refusals are recorded with their own action names, so those —
 * and only those — report a failure.
 */
function auditResult(action: string): 'success' | 'failure' {
  return /\.(reject|deny|denied|fail|failed|blocked)$/.test(action) ? 'failure' : 'success';
}

function parseWhen(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// GET /api/workspace/audit-logs — Pro-gated, paginated, read-only.
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = normalizeTier(workspace.plan_key);
    if (!hasFeature(tier, 'audit_logs')) {
      // A locked page still needs the plan facts to render its upgrade card.
      return res.json({
        plan: { key: tier, label: tierLabel(tier) },
        unlocked: false,
        required_plan: FEATURE_TIERS.audit_logs,
        total: 0,
        page: 1,
        page_size: 0,
        actions: [],
        logs: [],
      });
    }

    const pageSize = Math.min(Math.max(Number(req.query.page_size) || 25, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const base = await auditWhere(workspace.id, workspace.owner_id);
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const from = parseWhen(req.query.from);
    const to = parseWhen(req.query.to);

    const where = {
      AND: [
        base,
        ...(action ? [{ action }] : []),
        ...(from || to ? [{ created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }] : []),
      ],
    };

    const [total, rows, distinct] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      // Action list for the filter dropdown, taken from the rows that exist.
      prisma.auditLog.findMany({ where: base, select: { action: true }, distinct: ['action'] }),
    ]);

    res.json({
      plan: { key: tier, label: tierLabel(tier) },
      unlocked: true,
      required_plan: FEATURE_TIERS.audit_logs,
      total,
      page,
      page_size: pageSize,
      actions: distinct.map((row) => row.action).sort(),
      logs: rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        // NULL user_id means the actor was deleted or the action was internal.
        user: row.user ? { id: row.user.id, name: row.user.name, email: row.user.email } : null,
        action: row.action,
        resource: row.resource,
        ip: row.ip,
        result: auditResult(row.action),
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] audit logs failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load audit logs.');
  }
});

// GET /api/workspace/audit-logs.csv — Export CSV (§48). Same gate, same filters.
router.get('/audit-logs.csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = normalizeTier(workspace.plan_key);
    if (!hasFeature(tier, 'audit_logs')) return planLocked(res, 'audit_logs', tier);

    const base = await auditWhere(workspace.id, workspace.owner_id);
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const from = parseWhen(req.query.from);
    const to = parseWhen(req.query.to);

    const rows = await prisma.auditLog.findMany({
      where: {
        AND: [
          base,
          ...(action ? [{ action }] : []),
          ...(from || to
            ? [{ created_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }]
            : []),
        ],
      },
      orderBy: { created_at: 'desc' },
      // Bounded so an export can never stream the whole table into memory.
      take: 10_000,
      include: { user: { select: { email: true } } },
    });

    const escape = (value: string | number): string => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    // Metadata is deliberately left out: it can carry request details that do not
    // belong in a file the whole team can download.
    const lines = ['Date,User,Action,Resource,IP,Result'];
    for (const row of rows) {
      lines.push(
        [
          row.created_at.toISOString(),
          escape(row.user?.email ?? 'system'),
          escape(row.action),
          escape(row.resource ?? ''),
          escape(row.ip ?? ''),
          auditResult(row.action),
        ].join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="workspace-audit-${workspace.id}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] audit csv failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not export audit logs.');
  }
});

/**
 * DELETE /api/workspace — §50. Owner-only, and the caller must retype the exact
 * workspace name; a mismatch is refused rather than interpreted. Resources are
 * never destroyed as a side effect: `Project.workspace_project_id` is
 * `SetNull`, so cascading would quietly orphan running containers. The workspace
 * must be emptied first, mirroring how project deletion already behaves.
 */
router.delete('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const role = await workspaceRole(req, workspace.id);
    if (role !== 'owner') {
      return fail(res, 403, 'FORBIDDEN', 'Only the workspace owner can delete it.');
    }

    const body = (req.body ?? {}) as { name?: unknown; confirm?: unknown };
    const typed = typeof body.name === 'string' ? body.name : body.confirm;
    if (typeof typed !== 'string' || typed !== workspace.name) {
      return fail(
        res,
        400,
        'NAME_MISMATCH',
        `Type "${workspace.name}" exactly to confirm deletion.`,
      );
    }

    const resourceCount = await prisma.project.count({
      where: { workspace_project: { workspace_id: workspace.id } },
    });
    if (resourceCount > 0) {
      return fail(
        res,
        409,
        'NOT_EMPTY',
        `Delete the ${resourceCount} resource${resourceCount === 1 ? '' : 's'} in this workspace first.`,
      );
    }

    // An owner always has a workspace, and `ensureWorkspace` would immediately
    // recreate this one — so deleting the only one is refused instead of looping.
    const owned = await prisma.workspace.count({ where: { owner_id: workspace.owner_id } });
    if (owned <= 1) {
      return fail(
        res,
        409,
        'LAST_WORKSPACE',
        'This is your only workspace. Create another one before deleting this.',
      );
    }

    // Audited before the row disappears, so the record survives the cascade.
    await writeAudit(req, 'workspace.delete', `workspace:${workspace.id}`, {
      name: workspace.name,
    });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[workspace] delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the workspace.');
  }
});

export default router;
