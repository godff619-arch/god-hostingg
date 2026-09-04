import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import { dockerBin, isDockerMissing } from './dockerBin.js';

/**
 * A directory `docker compose down` can actually be spawned in.
 *
 * Teardown addresses containers by `-p <project>` (plus an absolute `-f` when a
 * runtime compose file exists), so it never needs the repo checkout. But spawning
 * with a `cwd` that no longer exists fails with ENOENT *before* Docker runs, and
 * `isDockerMissing` cannot tell that apart from "docker is not installed" — so a
 * project whose files are gone while its containers still run becomes impossible
 * to delete. The deployments root always exists, so fall back to it.
 */
export function composeTeardownCwd(preferred: string, fallback: string): string {
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    /* unreadable path — treat as missing */
  }
  return fallback;
}

export type ComposeResourceProbe = (projectName: string) => {
  containerIds: string[];
  networkIds: string[];
};

/** Exact-label probe: only Compose resources owned by this project name. */
export function probeComposeProjectResources(projectName: string): {
  containerIds: string[];
  networkIds: string[];
} {
  const containers = spawnSync(
    dockerBin(),
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`],
    { encoding: 'utf8', shell: false, timeout: 30000 }
  );
  const networks = spawnSync(
    dockerBin(),
    ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
    { encoding: 'utf8', shell: false, timeout: 30000 }
  );

  // No docker CLI at all → this process cannot own any container/network. Report
  // "gone" so teardown-dependent operations (delete/stop/cancel) are not blocked.
  if (isDockerMissing(containers.error) || isDockerMissing(networks.error)) {
    return { containerIds: [], networkIds: [] };
  }

  const splitIds = (out: string | null | undefined) =>
    String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    containerIds: containers.status === 0 ? splitIds(containers.stdout) : ['__probe_failed__'],
    networkIds: networks.status === 0 ? splitIds(networks.stdout) : ['__probe_failed__'],
  };
}

/** True when no containers/networks remain for this exact Compose project label. */
export function verifyComposeProjectGone(
  projectName: string,
  probe: ComposeResourceProbe = probeComposeProjectResources
): boolean {
  const { containerIds, networkIds } = probe(projectName);
  return containerIds.length === 0 && networkIds.length === 0;
}

/**
 * Teardown is OK when compose down exits 0, OR (nonzero) when an exact-label
 * postcondition proves no owned containers/networks remain.
 *
 * Never infer absence from stderr text like "not found" — that matches unrelated failures.
 */
export function isComposeTeardownOk(
  result: SpawnSyncReturns<string | Buffer>,
  projectName: string,
  probe: ComposeResourceProbe = probeComposeProjectResources
): boolean {
  // docker CLI missing → nothing this process could have started still runs.
  // Any other spawn error (timeout, etc.) is a hard failure.
  if (result.error && !isDockerMissing(result.error)) return false;
  if (result.status === 0) {
    // Still verify — exit 0 can race with leftover labeled resources
    return verifyComposeProjectGone(projectName, probe);
  }
  return verifyComposeProjectGone(projectName, probe);
}

/** After a failed stop/cancel teardown, proxy must be reattached so domains keep working. */
export function shouldReconnectProxyAfterFailedTeardown(teardownSucceeded: boolean): boolean {
  return !teardownSucceeded;
}
