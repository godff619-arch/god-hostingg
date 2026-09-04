// Docker CLI resolution + availability detection.
//
// Docklift is a Docker PaaS, but the control-plane process may run somewhere the
// `docker` binary is not on PATH (Windows dev boxes, minimal containers). When
// the CLI is genuinely absent, NO managed containers/volumes/networks can exist,
// so teardown guards can safely treat "docker missing" as "nothing to tear down"
// instead of blocking destructive-but-safe operations like project delete.

import { spawnSync } from 'child_process';

let cliAvailable: boolean | null = null;

/** The docker executable to invoke. `DOCKER_BIN` env overrides the PATH lookup. */
export function dockerBin(): string {
  const override = process.env.DOCKER_BIN?.trim();
  return override || 'docker';
}

/** True when a spawn error means the docker executable itself was not found. */
export function isDockerMissing(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/** True when a dockerode/daemon error means the engine socket is unreachable. */
export function isDockerDaemonUnreachable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '');
  return (
    isDockerMissing(err) ||
    /ENOENT|ECONNREFUSED|EACCES|docker_engine|\/var\/run\/docker\.sock|cannot connect to the docker daemon|is the docker daemon running|docker desktop is unable to start|docker desktop is starting|the system cannot find the file specified/i.test(
      msg,
    )
  );
}

/**
 * True when the socket is there but this process is not allowed to use it.
 *
 * Worth telling apart from "no engine": the fix is completely different. A panel
 * container that mounted `/var/run/docker.sock` but runs as a non-root user hits
 * this, and telling its operator to "install and start Docker" sends them off to
 * fix something that is already working.
 */
export function isDockerPermissionDenied(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  const msg = String(e?.message || err || '');
  return e?.code === 'EACCES' || /\bEACCES\b|permission denied/i.test(msg);
}

/**
 * Whether the docker CLI is installed and resolvable. Client-only probe
 * (`docker --version`) — does NOT require the daemon to be running. Cached after
 * the first call. When false, this process cannot manage containers at all.
 */
export function dockerCliAvailable(): boolean {
  if (cliAvailable !== null) return cliAvailable;
  try {
    const r = spawnSync(dockerBin(), ['--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 10000,
    });
    cliAvailable = !r.error && r.status === 0;
  } catch {
    cliAvailable = false;
  }
  return cliAvailable;
}

/** Reset the cached CLI probe (used by tests / after install detection). */
export function resetDockerCliCache(): void {
  cliAvailable = null;
}
