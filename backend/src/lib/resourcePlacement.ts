/**
 * Where a newly created resource lands in the Project → Environment hierarchy.
 *
 * Both `POST /api/projects` and `POST /api/databases` accept an explicit target so
 * a service deployed from inside a project/environment is born in the right place
 * instead of being swept into the workspace default later by
 * `adoptOrphanResources()`. Shared here (rather than in either route) so the two
 * entry points cannot drift apart on authorization.
 */
import type { Response } from 'express';
import prisma from './prisma.js';
import { ensureDefaultEnvironment } from './workspace.js';
import { type AuthenticatedRequest, isAdmin } from './authMiddleware.js';

export interface ResourcePlacement {
  workspace_project_id: string | null;
  environment_id: string | null;
}

export class PlacementError extends Error {
  readonly status: number;
  constructor(message: string, status = 404) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve + authorize an explicit `workspace_project_id` / `environment_id`.
 * Verifies the whole chain: current user → workspace membership → project group →
 * environment. Unknown *and* un-owned groups both answer 404 so ids cannot be
 * probed by swapping them into the request body. Viewers are refused (403).
 *
 * Omitting the project id is legal and yields `{ null, null }` (unassigned).
 */
export async function resolveResourcePlacement(
  req: AuthenticatedRequest,
  rawProjectId: unknown,
  rawEnvironmentId: unknown,
): Promise<ResourcePlacement> {
  const groupId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
  if (!groupId) return { workspace_project_id: null, environment_id: null };

  const group = await prisma.workspaceProject.findUnique({
    where: { id: groupId },
    select: { id: true, workspace_id: true, workspace: { select: { owner_id: true } } },
  });
  if (!group) throw new PlacementError('That project does not exist');

  const userId = req.user?.userId;
  if (!isAdmin(req) && userId && userId !== 'internal' && group.workspace.owner_id !== userId) {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspace_id: group.workspace_id, user_id: userId },
      select: { role: true },
    });
    if (!member) throw new PlacementError('That project does not exist');
    if (member.role === 'viewer') {
      throw new PlacementError('Viewers cannot create resources in this project', 403);
    }
  }

  let environmentId = typeof rawEnvironmentId === 'string' ? rawEnvironmentId.trim() : '';
  if (environmentId) {
    const environment = await prisma.environment.findFirst({
      where: { id: environmentId, workspace_project_id: group.id },
      select: { id: true },
    });
    if (!environment) {
      throw new PlacementError('That environment is not in the chosen project');
    }
  } else {
    environmentId = (await ensureDefaultEnvironment(group.id)).id;
  }

  return { workspace_project_id: group.id, environment_id: environmentId };
}

/** Translate a PlacementError into the legacy `{ error }` envelope these routes use. */
export function sendPlacementError(res: Response, err: unknown): boolean {
  if (err instanceof PlacementError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}
