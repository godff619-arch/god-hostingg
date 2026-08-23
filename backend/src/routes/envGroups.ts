// Environment Groups API.
//
// A group is a reusable set of environment variables owned by a workspace and
// linked to environments; every resource deployed in a linked environment
// inherits the group's variables (see lib/envGroups.ts for the precedence
// rules). Access is workspace-scoped through resolveWorkspace(), which answers
// 404 for a workspace the caller has no membership in, so group ids cannot be
// probed by editing the URL.
//
// Values are sealed at rest. A variable marked secret is never returned by any
// response — only its presence — which is why editing a secret means replacing
// it, not reading it back.

import express, { Response } from 'express';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { seal, open } from '../lib/secretBox.js';
import { isValidEnvKey, normalizeEnvValue } from '../lib/envVariables.js';
import {
  assertWorkspaceWrite,
  newId,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
  workspaceRole,
} from '../lib/workspace.js';

const router = express.Router();

const MAX_NAME = 60;
const MAX_VALUE = 8192;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAME) return null;
  return trimmed;
}

type GroupWithRelations = {
  id: string;
  workspace_id: string;
  name: string;
  created_at: Date;
  updated_at: Date | null;
  vars: Array<{
    id: string;
    key: string;
    value_enc: string;
    is_secret: boolean;
    updated_at: Date | null;
  }>;
  links: Array<{
    id: string;
    environment: {
      id: string;
      name: string;
      workspace_project: { id: string; name: string };
    };
  }>;
};

const GROUP_INCLUDE = {
  vars: { orderBy: { key: 'asc' } },
  links: {
    orderBy: { created_at: 'asc' },
    include: {
      environment: {
        include: { workspace_project: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

/**
 * Shape a group for the client. Non-secret values are returned as stored;
 * secret values are replaced by `null` with `is_secret: true`, so the UI can
 * show "•••" without the plaintext ever leaving the server.
 */
function shapeGroup(group: GroupWithRelations) {
  return {
    id: group.id,
    name: group.name,
    created_at: group.created_at,
    updated_at: group.updated_at,
    var_count: group.vars.length,
    secret_count: group.vars.filter((v) => v.is_secret).length,
    vars: group.vars.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.is_secret ? null : open(row.value_enc),
      is_secret: row.is_secret,
      updated_at: row.updated_at,
    })),
    links: group.links.map((link) => ({
      id: link.id,
      environment_id: link.environment.id,
      environment_name: link.environment.name,
      project_id: link.environment.workspace_project.id,
      project_name: link.environment.workspace_project.name,
    })),
  };
}

type ParsedVar = { key: string; value: string; is_secret: boolean };

/**
 * Validate an incoming `vars` array. Keys must be valid shell identifiers and
 * unique within the payload; duplicates are rejected rather than silently
 * collapsed, so nobody wonders which of two values won.
 */
function parseVars(
  input: unknown,
): { vars: ParsedVar[] } | { error: { code: string; message: string } } {
  if (input === undefined || input === null) return { vars: [] };
  if (!Array.isArray(input)) {
    return { error: { code: 'INVALID_VARS', message: '`vars` must be an array.' } };
  }

  const out: ParsedVar[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = raw as { key?: unknown; value?: unknown; is_secret?: unknown };
    if (!isValidEnvKey(entry?.key)) {
      return {
        error: {
          code: 'INVALID_KEY',
          message: 'Keys must start with a letter or underscore and contain only letters, digits and underscores.',
        },
      };
    }
    const key = entry.key;
    if (seen.has(key)) {
      return { error: { code: 'DUPLICATE_KEY', message: `“${key}” appears more than once.` } };
    }
    seen.add(key);

    const value = normalizeEnvValue(entry?.value);
    if (value.length > MAX_VALUE) {
      return {
        error: { code: 'VALUE_TOO_LONG', message: `“${key}” exceeds ${MAX_VALUE} characters.` },
      };
    }
    out.push({ key, value, is_secret: entry?.is_secret === true });
  }
  return { vars: out };
}

/** Load a group the caller may see, or throw the workspace 404. */
async function resolveGroup(req: AuthenticatedRequest, id: string) {
  const group = await prisma.envGroup.findUnique({
    where: { id },
    include: GROUP_INCLUDE,
  });
  if (!group) throw { status: 404, code: 'NOT_FOUND', message: 'Environment group not found.' };
  // Membership check. Non-members get 404 from resolveWorkspace, matching the
  // "unknown id" answer above so the two cases are indistinguishable.
  await resolveWorkspace(req, group.workspace_id);
  return group;
}

// GET /api/env-groups — every group in the workspace, with vars and links.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const [groups, role, projects] = await Promise.all([
      prisma.envGroup.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'asc' },
        include: GROUP_INCLUDE,
      }),
      workspaceRole(req, workspace.id),
      // Link targets: every environment in the workspace, so the dialog never
      // has to guess what exists.
      prisma.workspaceProject.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          name: true,
          environments: {
            orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
            select: { id: true, name: true },
          },
        },
      }),
    ]);

    res.json({
      workspace: { id: workspace.id, name: workspace.name },
      role,
      can_write: role !== 'viewer',
      groups: groups.map(shapeGroup),
      targets: projects.map((project) => ({
        project_id: project.id,
        project_name: project.name,
        environments: project.environments,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load environment groups.');
  }
});

// GET /api/env-groups/:id — one group.
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    res.json({ group: shapeGroup(group) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] read failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load the environment group.');
  }
});

// POST /api/env-groups — create a group, optionally with its first variables.
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);

    const clash = await prisma.envGroup.findFirst({
      where: { workspace_id: workspace.id, name },
    });
    if (clash) return fail(res, 409, 'DUPLICATE', `“${name}” already exists in this workspace.`);

    const parsed = parseVars(req.body?.vars);
    if ('error' in parsed) return fail(res, 400, parsed.error.code, parsed.error.message);

    const group = await prisma.envGroup.create({
      data: {
        id: newId('evg'),
        workspace_id: workspace.id,
        name,
        vars: {
          create: parsed.vars.map((v) => ({
            key: v.key,
            value_enc: seal(v.value),
            is_secret: v.is_secret,
          })),
        },
      },
      include: GROUP_INCLUDE,
    });

    await writeAudit(req, 'env_group.create', `env_group:${group.id}`, {
      name,
      vars: parsed.vars.length,
    });
    res.status(201).json({ success: true, group: shapeGroup(group) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create the environment group.');
  }
});

// PATCH /api/env-groups/:id — rename.
router.patch('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    await assertWorkspaceWrite(req, group.workspace_id);

    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);
    if (name === group.name) return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');

    const clash = await prisma.envGroup.findFirst({
      where: { workspace_id: group.workspace_id, name, id: { not: group.id } },
    });
    if (clash) return fail(res, 409, 'DUPLICATE', `“${name}” already exists in this workspace.`);

    const updated = await prisma.envGroup.update({
      where: { id: group.id },
      data: { name },
      include: GROUP_INCLUDE,
    });
    await writeAudit(req, 'env_group.rename', `env_group:${group.id}`, {
      from: group.name,
      to: name,
    });
    res.json({ success: true, group: shapeGroup(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] rename failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not rename the environment group.');
  }
});

// DELETE /api/env-groups/:id — removes the group, its variables and its links.
// Deployed resources keep the values they already have until their next deploy,
// which is stated in the confirmation dialog rather than implied.
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    await assertWorkspaceWrite(req, group.workspace_id);

    await prisma.envGroup.delete({ where: { id: group.id } });
    await writeAudit(req, 'env_group.delete', `env_group:${group.id}`, {
      name: group.name,
      vars: group.vars.length,
      links: group.links.length,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the environment group.');
  }
});

// PUT /api/env-groups/:id/vars — replace the whole variable set.
//
// The editor saves the table as a whole, so a full replace is what the UI
// actually means. A secret whose value comes back as null is kept as stored
// (the client never received it), which is what makes "edit the key, keep the
// secret" work without ever exposing plaintext.
router.put('/:id/vars', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    await assertWorkspaceWrite(req, group.workspace_id);

    if (!Array.isArray(req.body?.vars)) {
      return fail(res, 400, 'INVALID_VARS', '`vars` must be an array.');
    }

    // Rows the client sent back with `value: null` refer to secrets it could
    // not see; resolve them from the stored row by id.
    const byId = new Map(group.vars.map((row) => [row.id, row]));
    const incoming = req.body.vars as Array<{
      id?: unknown;
      key?: unknown;
      value?: unknown;
      is_secret?: unknown;
    }>;

    const prepared: Array<ParsedVar & { keepFrom?: string }> = [];
    const seen = new Set<string>();
    for (const entry of incoming) {
      if (!isValidEnvKey(entry?.key)) {
        return fail(
          res,
          400,
          'INVALID_KEY',
          'Keys must start with a letter or underscore and contain only letters, digits and underscores.',
        );
      }
      if (seen.has(entry.key)) {
        return fail(res, 400, 'DUPLICATE_KEY', `“${entry.key}” appears more than once.`);
      }
      seen.add(entry.key);

      const existingId = typeof entry.id === 'string' ? entry.id : undefined;
      const existing = existingId ? byId.get(existingId) : undefined;
      const keepStored = entry.value === null || entry.value === undefined;

      if (keepStored && !existing) {
        return fail(res, 400, 'MISSING_VALUE', `“${entry.key}” has no value.`);
      }

      const value = keepStored ? '' : normalizeEnvValue(entry.value);
      if (value.length > MAX_VALUE) {
        return fail(res, 400, 'VALUE_TOO_LONG', `“${entry.key}” exceeds ${MAX_VALUE} characters.`);
      }

      prepared.push({
        key: entry.key,
        value,
        is_secret: entry.is_secret === true,
        keepFrom: keepStored ? existing!.id : undefined,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.envGroupVar.deleteMany({ where: { group_id: group.id } });
      for (const row of prepared) {
        const stored = row.keepFrom ? byId.get(row.keepFrom) : undefined;
        await tx.envGroupVar.create({
          data: {
            group_id: group.id,
            key: row.key,
            value_enc: stored ? stored.value_enc : seal(row.value),
            is_secret: row.is_secret,
          },
        });
      }
      await tx.envGroup.update({ where: { id: group.id }, data: { updated_at: new Date() } });
    });

    const updated = await prisma.envGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: GROUP_INCLUDE,
    });
    await writeAudit(req, 'env_group.vars.update', `env_group:${group.id}`, {
      name: group.name,
      count: prepared.length,
      secrets: prepared.filter((r) => r.is_secret).length,
    });
    res.json({ success: true, group: shapeGroup(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] vars update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the variables.');
  }
});

// POST /api/env-groups/:id/links — link the group to an environment.
router.post('/:id/links', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    await assertWorkspaceWrite(req, group.workspace_id);

    const environmentId =
      typeof req.body?.environment_id === 'string' ? req.body.environment_id.trim() : '';
    if (!environmentId) {
      return fail(res, 400, 'INVALID_ENVIRONMENT', 'An environment is required.');
    }

    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      include: { workspace_project: { select: { workspace_id: true, name: true } } },
    });
    // Cross-workspace ids answer 404, exactly like an id that does not exist.
    if (!environment || environment.workspace_project.workspace_id !== group.workspace_id) {
      return fail(res, 404, 'NOT_FOUND', 'Environment not found.');
    }

    const existing = await prisma.envGroupLink.findFirst({
      where: { group_id: group.id, environment_id: environment.id },
    });
    if (existing) {
      return fail(res, 409, 'DUPLICATE', `Already linked to ${environment.name}.`);
    }

    await prisma.envGroupLink.create({
      data: { group_id: group.id, environment_id: environment.id },
    });
    await writeAudit(req, 'env_group.link', `env_group:${group.id}`, {
      name: group.name,
      environment: environment.id,
    });

    const updated = await prisma.envGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: GROUP_INCLUDE,
    });
    res.status(201).json({ success: true, group: shapeGroup(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] link failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not link the environment.');
  }
});

// DELETE /api/env-groups/:id/links/:environmentId — unlink.
router.delete('/:id/links/:environmentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const group = await resolveGroup(req, req.params.id);
    await assertWorkspaceWrite(req, group.workspace_id);

    const link = group.links.find((l) => l.environment.id === req.params.environmentId);
    if (!link) return fail(res, 404, 'NOT_FOUND', 'Link not found.');

    await prisma.envGroupLink.delete({ where: { id: link.id } });
    await writeAudit(req, 'env_group.unlink', `env_group:${group.id}`, {
      name: group.name,
      environment: link.environment.id,
    });

    const updated = await prisma.envGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: GROUP_INCLUDE,
    });
    res.json({ success: true, group: shapeGroup(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[env-groups] unlink failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not unlink the environment.');
  }
});

export default router;
