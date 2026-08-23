/**
 * Private Links — service-to-service networking that never leaves the host.
 *
 * A link attaches the *target* project's container to the *source* project's
 * Docker bridge network. Once attached, the source resolves the target by its
 * container name over that network, so nothing has to be published to the host
 * and no public DNS record exists. This is the same mechanism the managed-DB
 * links use (`lib/databaseLinks.ts`); the difference is that both ends here are
 * ordinary projects, so the address is built from the target's own port rather
 * than from an engine's credentials.
 *
 * Every apply reports what Docker actually did. When the daemon is down or the
 * target has never been deployed, the link is stored as `pending`/`error` with
 * the real reason — it is never recorded as active on the strength of a row
 * existing in the database.
 */

import prisma from './prisma.js';
import {
  connectContainerToProjectNetwork,
  disconnectContainerFromProjectNetwork,
} from '../services/docker.js';

/** Env keys we are willing to inject: POSIX-shell-safe upper snake case. */
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export const LINK_SCHEMES = ['http', 'tcp'] as const;
export type LinkScheme = (typeof LINK_SCHEMES)[number];

export interface LinkTargetHost {
  /** Container DNS name on the source's network. */
  host: string;
  /** Which service inside the target project the host belongs to. */
  serviceName: string;
}

/**
 * The container the target project answers on. `null` when the project has
 * never produced a container — the caller must then keep the link `pending`
 * rather than inventing a hostname.
 */
export async function targetHost(targetProjectId: string): Promise<LinkTargetHost | null> {
  const project = await prisma.project.findUnique({
    where: { id: targetProjectId },
    select: {
      container_name: true,
      services: {
        orderBy: { created_at: 'asc' },
        select: { name: true, container_name: true },
      },
    },
  });
  if (!project) return null;

  const service = project.services.find((s) => !!s.container_name?.trim());
  if (service?.container_name) {
    return { host: service.container_name, serviceName: service.name };
  }
  // Single-service legacy projects recorded the container on the project row.
  if (project.container_name?.trim()) {
    return { host: project.container_name, serviceName: 'app' };
  }
  return null;
}

/** The address the source uses. `http` gets a URL; `tcp` gets `host:port`. */
export function internalAddress(scheme: string, host: string, port: number): string {
  return scheme === 'http' ? `http://${host}:${port}` : `${host}:${port}`;
}

/**
 * Write the injected env var on the source project. Shared across the source's
 * services (`service_name: ''`) because a private link is a property of the
 * project, not of one container.
 */
async function upsertLinkEnv(sourceProjectId: string, key: string, value: string): Promise<void> {
  const existing = await prisma.envVariable.findFirst({
    where: { project_id: sourceProjectId, service_name: '', key },
  });
  if (existing) {
    await prisma.envVariable.update({
      where: { id: existing.id },
      data: { value, is_runtime: true, is_build_arg: false, is_secret: false },
    });
    return;
  }
  await prisma.envVariable.create({
    data: {
      project_id: sourceProjectId,
      service_name: '',
      key,
      value,
      is_runtime: true,
      is_build_arg: false,
      is_secret: false,
    },
  });
}

/**
 * Remove an injected env var only when no other private link on the same source
 * still owns that key. `exceptLinkId` is the link being deleted or re-pointed.
 */
async function deleteLinkEnvIfUnowned(
  sourceProjectId: string,
  key: string,
  exceptLinkId: string,
): Promise<void> {
  const stillOwned = await prisma.privateLink.count({
    where: { source_project_id: sourceProjectId, env_key: key, NOT: { id: exceptLinkId } },
  });
  if (stillOwned > 0) return;
  await prisma.envVariable.deleteMany({
    where: { project_id: sourceProjectId, service_name: '', key },
  });
}

export interface ApplyResult {
  status: 'active' | 'pending' | 'error';
  address: string | null;
  error: string | null;
}

/**
 * Attach the target to the source's network and inject the address. Returns the
 * honest outcome instead of throwing, so one broken link never fails the whole
 * page: `pending` means "nothing to attach yet", `error` means Docker refused.
 */
export async function applyPrivateLink(linkId: string): Promise<ApplyResult> {
  const link = await prisma.privateLink.findUnique({ where: { id: linkId } });
  if (!link) return { status: 'error', address: null, error: 'Link no longer exists.' };

  const target = await targetHost(link.target_project_id);
  if (!target) {
    const result: ApplyResult = {
      status: 'pending',
      address: null,
      error: 'The target has not been deployed yet, so it has no container to attach.',
    };
    await record(link.id, result);
    return result;
  }

  const address = internalAddress(link.scheme, target.host, link.target_port);
  try {
    await connectContainerToProjectNetwork(link.source_project_id, target.host);
  } catch (err) {
    const message = (err as Error)?.message || 'Docker refused the network attach.';
    const result: ApplyResult = { status: 'error', address, error: message };
    await record(link.id, result);
    return result;
  }

  if (link.env_key) {
    await upsertLinkEnv(link.source_project_id, link.env_key, address);
  }
  const result: ApplyResult = { status: 'active', address, error: null };
  await record(link.id, result);
  return result;
}

async function record(linkId: string, result: ApplyResult): Promise<void> {
  await prisma.privateLink.update({
    where: { id: linkId },
    data: {
      status: result.status,
      last_error: result.error,
      last_applied_at: new Date(),
    },
  });
}

/**
 * Detach one link. The container is only removed from the network when no other
 * link (private or managed-DB) still needs it there, so tearing down one link
 * never silently breaks another.
 */
export async function detachPrivateLink(linkId: string): Promise<void> {
  const link = await prisma.privateLink.findUnique({ where: { id: linkId } });
  if (!link) return;

  if (link.env_key) {
    await deleteLinkEnvIfUnowned(link.source_project_id, link.env_key, link.id);
  }

  const stillNeeded = await prisma.privateLink.count({
    where: {
      source_project_id: link.source_project_id,
      target_project_id: link.target_project_id,
      NOT: { id: link.id },
    },
  });
  const dbLink = await prisma.databaseLink.count({
    where: {
      app_project_id: link.source_project_id,
      database_project_id: link.target_project_id,
    },
  });
  if (stillNeeded > 0 || dbLink > 0) return;

  const target = await targetHost(link.target_project_id);
  if (!target) return;
  await disconnectContainerFromProjectNetwork(link.source_project_id, target.host);
}

/**
 * Re-apply every link that consumes this project after it redeploys — a fresh
 * container needs re-attaching and the injected address may have changed.
 */
export async function reapplyLinksForTarget(targetProjectId: string): Promise<void> {
  const links = await prisma.privateLink.findMany({
    where: { target_project_id: targetProjectId },
    select: { id: true },
  });
  for (const link of links) {
    try {
      await applyPrivateLink(link.id);
    } catch (err) {
      console.warn(`[privateLinks] Failed to re-apply ${link.id}:`, err);
    }
  }
}

/**
 * Re-apply every link this project consumes after it redeploys — compose down
 * removes the project network, so the targets must be re-attached to the new one.
 */
export async function reapplyLinksForSource(sourceProjectId: string): Promise<void> {
  const links = await prisma.privateLink.findMany({
    where: { source_project_id: sourceProjectId },
    select: { id: true },
  });
  for (const link of links) {
    try {
      await applyPrivateLink(link.id);
    } catch (err) {
      console.warn(`[privateLinks] Failed to re-apply ${link.id}:`, err);
    }
  }
}
