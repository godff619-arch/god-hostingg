// Blueprints API — Part A → Blueprints.
//
// A blueprint is infrastructure-as-code for a workspace: a `godhosting.yaml`-shaped
// spec that, when applied, creates the real services and managed databases it
// declares in a project group + environment the caller picks. It is not a
// template gallery — every apply goes through the same creation paths (and the
// same quota checks) as the New Project / New Database flows.
//
// Access follows the rest of the workspace layer: `resolveWorkspace` answers 404
// (not 403) for non-members so blueprint ids cannot be probed by editing the URL,
// and `assertWorkspaceWrite` blocks viewers from every mutation.
//
// Deliberately **not** plan-gated: Render offers Blueprints on every plan, and
// gating IaC would only push users into hand-clicking the same resources.

import express, { Response } from 'express';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest, isAdmin } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import {
  assertWorkspaceWrite,
  createWorkspaceProject,
  ensureDefaultEnvironment,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
  workspaceRole,
} from '../lib/workspace.js';
import {
  applyBlueprint,
  exampleSpec,
  fetchSpecFromRepo,
  parseSpec,
  SERVICE_TYPES,
  SPEC_FORMATS,
  type SpecFormat,
} from '../lib/blueprints.js';
import { listDatabaseEngines } from '../lib/databaseEngines.js';

const router = express.Router();

const MAX_NAME = 60;
const MAX_DESCRIPTION = 240;
const MAX_SPEC_BYTES = 256 * 1024;
/** Newest runs kept on the row; the full history stays in the table. */
const RUN_LIMIT = 10;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

const RUN_SELECT = {
  id: true,
  status: true,
  created_count: true,
  skipped_count: true,
  failed_count: true,
  log: true,
  error: true,
  created_at: true,
  finished_at: true,
  workspace_project_id: true,
  environment_id: true,
} as const;

const BLUEPRINT_INCLUDE = {
  applies: { orderBy: { created_at: 'desc' }, take: RUN_LIMIT, select: RUN_SELECT },
} as const;

/** Every blueprint in a workspace, newest first, with its recent runs. */
async function findBlueprints(workspaceId: string) {
  return prisma.blueprint.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: 'desc' },
    include: BLUEPRINT_INCLUDE,
  });
}

type BlueprintRow = Awaited<ReturnType<typeof findBlueprints>>[number];

/**
 * Shape a blueprint for the UI. The parsed summary travels with the row so the
 * list can show "2 services, 1 database" without the client re-implementing the
 * parser — and shows the spec's own errors when it no longer parses.
 */
function shapeBlueprint(row: BlueprintRow) {
  const parsed = parseSpec(row.spec, row.spec_format);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    repo_url: row.repo_url,
    repo_branch: row.repo_branch,
    spec_path: row.spec_path,
    spec: row.spec,
    spec_format: row.spec_format,
    last_synced_at: row.last_synced_at,
    last_sync_error: row.last_sync_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    summary: {
      services: parsed.services.map((s) => ({
        name: s.name,
        type: s.type,
        repo: s.repo,
        branch: s.branch,
        port: s.port,
        env_count: s.envVars.length,
      })),
      databases: parsed.databases.map((d) => ({
        name: d.name,
        engine: d.engine,
        version: d.version,
      })),
      /** Non-empty means an apply would refuse to start. */
      errors: parsed.errors,
    },
    applies: row.applies,
  };
}

/** Every environment in the workspace, so the apply dialog never guesses. */
async function applyTargets(workspaceId: string) {
  const projects = await prisma.workspaceProject.findMany({
    where: { workspace_id: workspaceId },
    orderBy: { created_at: 'asc' },
    select: {
      id: true,
      name: true,
      environments: {
        orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
        select: { id: true, name: true },
      },
    },
  });
  return projects.map((project) => ({
    project_id: project.id,
    project_name: project.name,
    environments: project.environments,
  }));
}

function readSpecFormat(value: unknown, fallback: SpecFormat = 'yaml'): SpecFormat | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return (SPEC_FORMATS as readonly string[]).includes(trimmed) ? (trimmed as SpecFormat) : null;
}

// GET /api/blueprints — the workspace's blueprints plus what an apply can target.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const [blueprints, role, targets] = await Promise.all([
      findBlueprints(workspace.id),
      workspaceRole(req, workspace.id),
      applyTargets(workspace.id),
    ]);

    res.json({
      workspace: { id: workspace.id, name: workspace.name },
      role,
      can_write: role !== 'viewer',
      blueprints: blueprints.map(shapeBlueprint),
      targets,
      // The editor's own reference data, so the page never hardcodes either list.
      service_types: SERVICE_TYPES,
      spec_formats: SPEC_FORMATS,
      engines: listDatabaseEngines().map((e) => ({ id: e.id, label: e.label })),
      example_spec: exampleSpec(),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load blueprints.');
  }
});

// POST /api/blueprints/validate — parse a spec without saving anything.
router.post('/validate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Resolve the workspace anyway: validation is a member-only surface.
    await resolveWorkspace(req, requestedWorkspaceId(req));
    const body = (req.body ?? {}) as { spec?: unknown; spec_format?: unknown };
    const spec = typeof body.spec === 'string' ? body.spec : '';
    if (Buffer.byteLength(spec, 'utf8') > MAX_SPEC_BYTES) {
      return fail(res, 400, 'SPEC_TOO_LARGE', 'The spec is larger than 256 KiB.');
    }
    const format = readSpecFormat(body.spec_format);
    if (!format) {
      return fail(res, 400, 'INVALID_FORMAT', `Format must be one of: ${SPEC_FORMATS.join(', ')}.`);
    }
    const parsed = parseSpec(spec, format);
    res.json({
      ok: parsed.errors.length === 0,
      errors: parsed.errors,
      services: parsed.services,
      databases: parsed.databases,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] validate failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not validate the spec.');
  }
});

// POST /api/blueprints — save a blueprint, either pasted or pulled from a repo.
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      source?: unknown;
      repo_url?: unknown;
      repo_branch?: unknown;
      spec_path?: unknown;
      spec?: unknown;
      spec_format?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME) {
      return fail(res, 400, 'INVALID_NAME', `A name of 1–${MAX_NAME} characters is required.`);
    }
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim().slice(0, MAX_DESCRIPTION)
        : null;

    const source = body.source === 'repo' ? 'repo' : 'manual';
    const format = readSpecFormat(body.spec_format);
    if (!format) {
      return fail(res, 400, 'INVALID_FORMAT', `Format must be one of: ${SPEC_FORMATS.join(', ')}.`);
    }

    let spec = typeof body.spec === 'string' ? body.spec : '';
    let repoUrl: string | null = null;
    let repoBranch: string | null = null;
    let specPath: string | null = null;
    let syncedAt: Date | null = null;

    if (source === 'repo') {
      repoUrl = typeof body.repo_url === 'string' ? body.repo_url.trim() : '';
      specPath =
        typeof body.spec_path === 'string' && body.spec_path.trim()
          ? body.spec_path.trim()
          : 'docklift.yaml';
      repoBranch =
        typeof body.repo_branch === 'string' && body.repo_branch.trim()
          ? body.repo_branch.trim()
          : null;
      if (!repoUrl) {
        return fail(res, 400, 'INVALID_REPO', 'A repository URL is required for a repo blueprint.');
      }
      const fetched = await fetchSpecFromRepo(repoUrl, repoBranch, specPath);
      if (!fetched.ok) {
        // The clone's own reason, not a generic failure.
        return fail(res, 400, 'SYNC_FAILED', fetched.error);
      }
      spec = fetched.spec;
      syncedAt = new Date();
    }

    if (!spec.trim()) {
      return fail(res, 400, 'INVALID_SPEC', 'The spec cannot be empty.');
    }
    if (Buffer.byteLength(spec, 'utf8') > MAX_SPEC_BYTES) {
      return fail(res, 400, 'SPEC_TOO_LARGE', 'The spec is larger than 256 KiB.');
    }

    const parsed = parseSpec(spec, format);
    if (parsed.errors.length) {
      return fail(res, 400, 'INVALID_SPEC', parsed.errors[0]);
    }

    const duplicate = await prisma.blueprint.findFirst({
      where: { workspace_id: workspace.id, name },
      select: { id: true },
    });
    if (duplicate) {
      return fail(res, 409, 'DUPLICATE', `A blueprint named "${name}" already exists.`);
    }

    const created = await prisma.blueprint.create({
      data: {
        workspace_id: workspace.id,
        name,
        description,
        source,
        repo_url: repoUrl,
        repo_branch: repoBranch,
        spec_path: specPath,
        spec,
        spec_format: format,
        last_synced_at: syncedAt,
      },
      include: BLUEPRINT_INCLUDE,
    });

    await writeAudit(req, 'blueprint.create', `blueprint:${created.id}`, {
      name,
      source,
      services: parsed.services.length,
      databases: parsed.databases.length,
    });

    res.status(201).json({ success: true, blueprint: shapeBlueprint(created) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the blueprint.');
  }
});

/** Load a blueprint the caller may act on, or answer 404 exactly like the rest. */
async function loadBlueprint(req: AuthenticatedRequest, id: string) {
  const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
  const blueprint = await prisma.blueprint.findFirst({
    where: { id, workspace_id: workspace.id },
    include: BLUEPRINT_INCLUDE,
  });
  return { workspace, blueprint };
}

// PATCH /api/blueprints/:id — rename, re-describe, or replace the spec.
router.patch('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { workspace, blueprint } = await loadBlueprint(req, req.params.id);
    if (!blueprint) return fail(res, 404, 'NOT_FOUND', 'Blueprint not found.');
    await assertWorkspaceWrite(req, workspace.id);

    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      spec?: unknown;
      spec_format?: unknown;
      repo_url?: unknown;
      repo_branch?: unknown;
      spec_path?: unknown;
    };

    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > MAX_NAME) {
        return fail(res, 400, 'INVALID_NAME', `A name of 1–${MAX_NAME} characters is required.`);
      }
      if (name.toLowerCase() !== blueprint.name.toLowerCase()) {
        const clash = await prisma.blueprint.findFirst({
          where: { workspace_id: workspace.id, name },
          select: { id: true },
        });
        if (clash) {
          return fail(res, 409, 'DUPLICATE', `A blueprint named "${name}" already exists.`);
        }
      }
      data.name = name;
    }

    if (body.description !== undefined) {
      data.description =
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim().slice(0, MAX_DESCRIPTION)
          : null;
    }

    const format = body.spec_format !== undefined
      ? readSpecFormat(body.spec_format, blueprint.spec_format as SpecFormat)
      : (blueprint.spec_format as SpecFormat);
    if (!format) {
      return fail(res, 400, 'INVALID_FORMAT', `Format must be one of: ${SPEC_FORMATS.join(', ')}.`);
    }

    if (body.spec !== undefined || body.spec_format !== undefined) {
      const spec = body.spec !== undefined ? String(body.spec ?? '') : blueprint.spec;
      if (!spec.trim()) {
        return fail(res, 400, 'INVALID_SPEC', 'The spec cannot be empty.');
      }
      if (Buffer.byteLength(spec, 'utf8') > MAX_SPEC_BYTES) {
        return fail(res, 400, 'SPEC_TOO_LARGE', 'The spec is larger than 256 KiB.');
      }
      const parsed = parseSpec(spec, format);
      if (parsed.errors.length) {
        return fail(res, 400, 'INVALID_SPEC', parsed.errors[0]);
      }
      data.spec = spec;
      data.spec_format = format;
      // Hand-editing a repo blueprint makes it diverge from the file, so it
      // becomes a manual blueprint rather than silently claiming to be in sync.
      if (blueprint.source === 'repo' && body.spec !== undefined && spec !== blueprint.spec) {
        data.source = 'manual';
        data.last_sync_error = null;
      }
    }

    if (body.repo_url !== undefined) {
      const repoUrl = typeof body.repo_url === 'string' ? body.repo_url.trim() : '';
      data.repo_url = repoUrl || null;
    }
    if (body.repo_branch !== undefined) {
      const branch = typeof body.repo_branch === 'string' ? body.repo_branch.trim() : '';
      data.repo_branch = branch || null;
    }
    if (body.spec_path !== undefined) {
      const specPath = typeof body.spec_path === 'string' ? body.spec_path.trim() : '';
      data.spec_path = specPath || null;
    }

    if (!Object.keys(data).length) {
      return fail(res, 400, 'NOTHING_TO_UPDATE', 'No supported fields were provided.');
    }

    const updated = await prisma.blueprint.update({
      where: { id: blueprint.id },
      data,
      include: BLUEPRINT_INCLUDE,
    });
    await writeAudit(req, 'blueprint.update', `blueprint:${blueprint.id}`, {
      fields: Object.keys(data),
    });
    res.json({ success: true, blueprint: shapeBlueprint(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the blueprint.');
  }
});

// POST /api/blueprints/:id/sync — re-read the spec from its repository.
router.post('/:id/sync', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { workspace, blueprint } = await loadBlueprint(req, req.params.id);
    if (!blueprint) return fail(res, 404, 'NOT_FOUND', 'Blueprint not found.');
    await assertWorkspaceWrite(req, workspace.id);

    if (!blueprint.repo_url) {
      return fail(
        res,
        400,
        'NOT_REPO_BACKED',
        'This blueprint has no repository to sync from — edit the spec directly.',
      );
    }

    const fetched = await fetchSpecFromRepo(
      blueprint.repo_url,
      blueprint.repo_branch,
      blueprint.spec_path || 'docklift.yaml',
    );
    if (!fetched.ok) {
      // Record the failure on the row so the page can show why it is stale.
      const stale = await prisma.blueprint.update({
        where: { id: blueprint.id },
        data: { last_sync_error: fetched.error },
        include: BLUEPRINT_INCLUDE,
      });
      await writeAudit(req, 'blueprint.sync.failed', `blueprint:${blueprint.id}`, {
        error: fetched.error,
      });
      return res
        .status(400)
        .json({ success: false, error: { code: 'SYNC_FAILED', message: fetched.error }, blueprint: shapeBlueprint(stale) });
    }

    const parsed = parseSpec(fetched.spec, blueprint.spec_format);
    const updated = await prisma.blueprint.update({
      where: { id: blueprint.id },
      data: {
        spec: fetched.spec,
        source: 'repo',
        last_synced_at: new Date(),
        // The spec is stored even when it no longer parses — the summary carries
        // the errors, so the user sees the real file rather than a stale copy.
        last_sync_error: parsed.errors.length ? parsed.errors[0] : null,
      },
      include: BLUEPRINT_INCLUDE,
    });
    await writeAudit(req, 'blueprint.sync', `blueprint:${blueprint.id}`, {
      spec_path: blueprint.spec_path,
      errors: parsed.errors.length,
    });
    res.json({ success: true, blueprint: shapeBlueprint(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] sync failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not sync the blueprint.');
  }
});

// POST /api/blueprints/:id/apply — create everything the spec declares.
router.post('/:id/apply', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { workspace, blueprint } = await loadBlueprint(req, req.params.id);
    if (!blueprint) return fail(res, 404, 'NOT_FOUND', 'Blueprint not found.');
    await assertWorkspaceWrite(req, workspace.id);

    const body = (req.body ?? {}) as {
      project_id?: unknown;
      environment_id?: unknown;
      new_project_name?: unknown;
    };

    let workspaceProjectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
    let environmentId =
      typeof body.environment_id === 'string' ? body.environment_id.trim() : '';

    if (!workspaceProjectId) {
      // No target chosen: create a project group for this apply. Named after the
      // blueprint unless the caller supplied a name.
      const newName =
        typeof body.new_project_name === 'string' && body.new_project_name.trim()
          ? body.new_project_name.trim().slice(0, 120)
          : blueprint.name;
      const group = await createWorkspaceProject(workspace.id, newName, `Created from blueprint ${blueprint.name}`);
      workspaceProjectId = group.id;
      environmentId = (await ensureDefaultEnvironment(group.id)).id;
    } else {
      const group = await prisma.workspaceProject.findFirst({
        where: { id: workspaceProjectId, workspace_id: workspace.id },
        select: { id: true },
      });
      if (!group) {
        return fail(res, 404, 'NOT_FOUND', 'That project is not in this workspace.');
      }
      if (environmentId) {
        const environment = await prisma.environment.findFirst({
          where: { id: environmentId, workspace_project_id: group.id },
          select: { id: true },
        });
        if (!environment) {
          return fail(res, 404, 'NOT_FOUND', 'That environment is not in the chosen project.');
        }
      } else {
        environmentId = (await ensureDefaultEnvironment(group.id)).id;
      }
    }

    const ownerId =
      req.user?.userId && req.user.userId !== 'internal' ? req.user.userId : null;

    const outcome = await applyBlueprint(
      {
        id: blueprint.id,
        workspace_id: workspace.id,
        spec: blueprint.spec,
        spec_format: blueprint.spec_format,
      },
      {
        workspaceProjectId,
        environmentId,
        ownerId,
        skipQuota: isAdmin(req),
      },
    );

    await writeAudit(req, 'blueprint.apply', `blueprint:${blueprint.id}`, {
      apply: outcome.id,
      status: outcome.status,
      created: outcome.created_count,
      skipped: outcome.skipped_count,
      failed: outcome.failed_count,
      project: workspaceProjectId,
      environment: environmentId,
    });

    const refreshed = await prisma.blueprint.findFirst({
      where: { id: blueprint.id },
      include: BLUEPRINT_INCLUDE,
    });

    // 200 even for a partial/failed run: the run itself is a real result the page
    // renders. `outcome.status` is the truth, not the HTTP code.
    res.json({
      success: outcome.status !== 'failed',
      apply: outcome,
      project_id: workspaceProjectId,
      environment_id: environmentId,
      blueprint: refreshed ? shapeBlueprint(refreshed) : null,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] apply failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not apply the blueprint.');
  }
});

// GET /api/blueprints/:id/applies — the full run history for one blueprint.
router.get('/:id/applies', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { blueprint } = await loadBlueprint(req, req.params.id);
    if (!blueprint) return fail(res, 404, 'NOT_FOUND', 'Blueprint not found.');
    const applies = await prisma.blueprintApply.findMany({
      where: { blueprint_id: blueprint.id },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: RUN_SELECT,
    });
    res.json({ applies });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] history failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load the apply history.');
  }
});

// DELETE /api/blueprints/:id — removes the spec only; created resources stay.
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { workspace, blueprint } = await loadBlueprint(req, req.params.id);
    if (!blueprint) return fail(res, 404, 'NOT_FOUND', 'Blueprint not found.');
    await assertWorkspaceWrite(req, workspace.id);

    await prisma.blueprint.delete({ where: { id: blueprint.id } });
    await writeAudit(req, 'blueprint.delete', `blueprint:${blueprint.id}`, {
      name: blueprint.name,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[blueprints] delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the blueprint.');
  }
});

export default router;
