// Private Links API — Part A → NETWORKING → Private Links.
//
// A private link lets one project reach another over Docker's internal bridge
// network only: no published host port, no public DNS, nothing reachable from
// outside the machine. Both ends must live in the workspace the caller resolved,
// which `resolveWorkspace` answers 404 (not 403) for outsiders, so ids cannot be
// probed by editing the URL.
//
// Unlike webhooks and dedicated IPs this is deliberately **not** plan-gated.
// Private service-to-service traffic is the secure default; charging for it
// would push Hobby workspaces into publishing host ports instead, which is
// strictly worse. Render likewise gives private networking on every plan.

import express, { Response } from 'express';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import {
  assertWorkspaceWrite,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
  workspaceRole,
} from '../lib/workspace.js';
import { getDockerEngineInfo } from '../services/docker.js';
import {
  applyPrivateLink,
  detachPrivateLink,
  ENV_KEY_RE,
  internalAddress,
  LINK_SCHEMES,
  targetHost,
  type LinkScheme,
} from '../lib/privateLinks.js';

const router = express.Router();

const MAX_NAME = 60;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Deployable resources in this workspace — the only valid ends of a link. */
async function workspaceProjects(workspaceId: string) {
  return prisma.project.findMany({
    where: { workspace_project: { workspace_id: workspaceId } },
    orderBy: [{ project_type: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      project_type: true,
      db_engine: true,
      internal_port: true,
      status: true,
      services: {
        orderBy: { created_at: 'asc' },
        select: { name: true, container_name: true, internal_port: true },
      },
    },
  });
}

type WorkspaceProjectRow = Awaited<ReturnType<typeof workspaceProjects>>[number];

/**
 * What a project offers as a link target. `container` is NULL until it has been
 * deployed once — the UI says "not deployed yet" instead of guessing a hostname.
 */
function candidate(project: WorkspaceProjectRow) {
  const service = project.services.find((s) => !!s.container_name?.trim());
  return {
    id: project.id,
    name: project.name,
    kind: project.project_type === 'database' ? 'database' : 'app',
    engine: project.db_engine,
    status: project.status ?? null,
    container: service?.container_name ?? null,
    /** Port we suggest; the caller may override it. */
    suggested_port: service?.internal_port ?? project.internal_port ?? null,
  };
}

function shapeLink(
  link: {
    id: string;
    name: string;
    source_project_id: string;
    target_project_id: string;
    target_port: number;
    scheme: string;
    env_key: string | null;
    status: string;
    last_error: string | null;
    last_applied_at: Date | null;
    created_at: Date;
  },
  names: Map<string, string>,
  hosts: Map<string, string | null>,
) {
  const host = hosts.get(link.target_project_id) ?? null;
  return {
    id: link.id,
    name: link.name,
    source: { id: link.source_project_id, name: names.get(link.source_project_id) ?? 'Deleted' },
    target: { id: link.target_project_id, name: names.get(link.target_project_id) ?? 'Deleted' },
    target_port: link.target_port,
    scheme: link.scheme,
    env_key: link.env_key,
    status: link.status,
    last_error: link.last_error,
    last_applied_at: link.last_applied_at,
    created_at: link.created_at,
    // NULL while the target has no container — never a fabricated address.
    address: host ? internalAddress(link.scheme, host, link.target_port) : null,
  };
}

// GET /api/private-links — every link in the workspace plus the valid endpoints.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const role = await workspaceRole(req, workspace.id);

    const [links, projects, docker] = await Promise.all([
      prisma.privateLink.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'desc' },
      }),
      workspaceProjects(workspace.id),
      getDockerEngineInfo(),
    ]);

    const names = new Map(projects.map((p) => [p.id, p.name]));
    const candidates = projects.map(candidate);
    const hosts = new Map(candidates.map((c) => [c.id, c.container]));

    res.json({
      workspace: { id: workspace.id, name: workspace.name },
      can_write: role !== 'viewer',
      links: links.map((link) => shapeLink(link, names, hosts)),
      candidates,
      schemes: LINK_SCHEMES,
      // The page says so out loud when the daemon is down, because every link
      // stays pending until it is back.
      docker: { reachable: docker.daemonReachable, message: docker.message },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[private-links] list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load private links.');
  }
});

// POST /api/private-links — declare a link and apply it immediately.
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const body = (req.body ?? {}) as {
      name?: unknown;
      source?: unknown;
      target?: unknown;
      port?: unknown;
      scheme?: unknown;
      env_key?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME) {
      return fail(res, 400, 'INVALID_NAME', `A name of 1–${MAX_NAME} characters is required.`);
    }

    const sourceId = typeof body.source === 'string' ? body.source.trim() : '';
    const targetId = typeof body.target === 'string' ? body.target.trim() : '';
    if (!sourceId || !targetId) {
      return fail(res, 400, 'INVALID_ENDPOINTS', 'Both a source and a target are required.');
    }
    if (sourceId === targetId) {
      return fail(res, 400, 'SAME_PROJECT', 'A project cannot privately link to itself.');
    }

    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail(res, 400, 'INVALID_PORT', 'The port must be an integer between 1 and 65535.');
    }

    const scheme = (typeof body.scheme === 'string' ? body.scheme.trim() : 'http') as LinkScheme;
    if (!LINK_SCHEMES.includes(scheme)) {
      return fail(res, 400, 'INVALID_SCHEME', `Scheme must be one of: ${LINK_SCHEMES.join(', ')}.`);
    }

    let envKey: string | null = null;
    if (typeof body.env_key === 'string' && body.env_key.trim()) {
      envKey = body.env_key.trim().toUpperCase();
      if (!ENV_KEY_RE.test(envKey) || envKey.length > 64) {
        return fail(
          res,
          400,
          'INVALID_ENV_KEY',
          'An env key must be upper snake case, start with a letter and be at most 64 characters.',
        );
      }
    }

    // Both ends must be in this workspace. Anything else is 404, not 403, so a
    // caller cannot learn that some other workspace's project id exists.
    const projects = await workspaceProjects(workspace.id);
    const source = projects.find((p) => p.id === sourceId);
    const target = projects.find((p) => p.id === targetId);
    if (!source || !target) {
      return fail(res, 404, 'NOT_FOUND', 'That resource is not in this workspace.');
    }
    if (source.project_type === 'database') {
      return fail(
        res,
        400,
        'INVALID_SOURCE',
        'A database cannot be the consumer of a link — pick the app that connects to it.',
      );
    }

    const duplicate = await prisma.privateLink.findFirst({
      where: { source_project_id: sourceId, target_project_id: targetId, target_port: port },
    });
    if (duplicate) {
      return fail(
        res,
        409,
        'DUPLICATE',
        `${source.name} already has a private link to ${target.name} on port ${port}.`,
      );
    }

    const created = await prisma.privateLink.create({
      data: {
        workspace_id: workspace.id,
        source_project_id: sourceId,
        target_project_id: targetId,
        name,
        target_port: port,
        scheme,
        env_key: envKey,
      },
    });

    const result = await applyPrivateLink(created.id);
    void writeAudit(req, 'private_link.create', `private_link:${created.id}`, {
      workspace: workspace.id,
      source: sourceId,
      target: targetId,
      port,
      env_key: envKey,
      status: result.status,
    });

    const fresh = await prisma.privateLink.findUnique({ where: { id: created.id } });
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const host = await targetHost(targetId);
    const hosts = new Map<string, string | null>([[targetId, host?.host ?? null]]);
    res.status(201).json({
      success: true,
      link: fresh ? shapeLink(fresh, names, hosts) : null,
      applied: result,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[private-links] create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create the private link.');
  }
});

// POST /api/private-links/:id/apply — retry the attach after a redeploy or a
// Docker outage. Reports the real outcome, including failure.
router.post('/:id/apply', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const link = await prisma.privateLink.findFirst({
      where: { id: req.params.id, workspace_id: workspace.id },
    });
    if (!link) return fail(res, 404, 'NOT_FOUND', 'Private link not found.');

    const result = await applyPrivateLink(link.id);
    void writeAudit(req, 'private_link.apply', `private_link:${link.id}`, {
      workspace: workspace.id,
      status: result.status,
    });
    res.json({ success: true, applied: result });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[private-links] apply failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not apply the private link.');
  }
});

// DELETE /api/private-links/:id — detach, drop the injected env, remove the row.
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const link = await prisma.privateLink.findFirst({
      where: { id: req.params.id, workspace_id: workspace.id },
    });
    if (!link) return fail(res, 404, 'NOT_FOUND', 'Private link not found.');

    await detachPrivateLink(link.id);
    await prisma.privateLink.delete({ where: { id: link.id } });
    void writeAudit(req, 'private_link.delete', `private_link:${link.id}`, {
      workspace: workspace.id,
      source: link.source_project_id,
      target: link.target_project_id,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[private-links] delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not remove the private link.');
  }
});

export default router;
