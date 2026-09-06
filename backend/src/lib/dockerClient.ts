// The one Docker engine connection the control plane uses.
//
// `new Docker()` with no arguments hard-codes `/var/run/docker.sock` on anything
// that is not Windows. That is the right socket on a plain root install and the
// wrong one everywhere else: a rootless daemon puts it under `$XDG_RUNTIME_DIR`,
// Docker Desktop puts it under `~/.docker/run`, and a remote engine has no local
// socket at all. In each of those cases the panel reports "Docker unavailable
// (ENOENT)" while docker is running perfectly well one directory over.
//
// So: honour `DOCKER_HOST` first (it is how every other docker tool is pointed at
// an engine), then probe the sockets that actually exist on this host. Whatever
// is chosen is written back into `process.env.DOCKER_HOST`, because deploys run
// through spawned `docker` / `docker compose` children — if dockerode talked to
// Docker Desktop while the CLI talked to nothing, builds would fail with an error
// that contradicts the health page.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Docker from 'dockerode';

/** Sockets to try, most specific first. Missing env vars drop out. */
function candidateSockets(): string[] {
  const home = os.homedir();
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  return [
    '/var/run/docker.sock',
    // Rootless docker, both spellings — `XDG_RUNTIME_DIR` is unset under systemd
    // units and cron, where the uid path is the only way to find the socket.
    xdg ? path.join(xdg, 'docker.sock') : null,
    uid !== null ? `/run/user/${uid}/docker.sock` : null,
    // Docker Desktop (macOS, and Windows running under WSL).
    path.join(home, '.docker', 'run', 'docker.sock'),
    path.join(home, '.docker', 'desktop', 'docker.sock'),
    '/run/docker.sock',
  ].filter((p): p is string => !!p);
}

/** True when `p` exists and is a unix socket we may at least try to open. */
function isSocket(p: string): boolean {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
}

/**
 * Resolve the engine endpoint once, at module load.
 *
 * Returns null when `DOCKER_HOST` is already set — dockerode's own modem parses
 * it (unix://, tcp://, npipe://, TLS material from `DOCKER_CERT_PATH`), and
 * re-implementing that parsing here would only introduce a second, worse one.
 */
function resolveSocketPath(): string | null {
  if (process.env.DOCKER_HOST?.trim()) return null;
  if (process.platform === 'win32') return null;

  const found = candidateSockets().find(isSocket);
  if (!found) return null;

  // Point spawned CLI children at the same engine. Only set when we found it
  // ourselves; an operator-supplied DOCKER_HOST is never overwritten.
  process.env.DOCKER_HOST = `unix://${found}`;
  return found;
}

const socketPath = resolveSocketPath();

/**
 * Where this process is talking to Docker, for the operations health page and for
 * the unreachable-engine message. `DOCKER_HOST` when the operator set one, else the
 * socket we discovered, else dockerode's own default for this platform — which is
 * the named pipe on Windows, not a unix socket. Printing the wrong one of those two
 * sends an operator looking for a file that was never going to exist.
 */
export const dockerEndpoint: string =
  process.env.DOCKER_HOST?.trim() ||
  (socketPath
    ? `unix://${socketPath}`
    : process.platform === 'win32'
      ? 'npipe:////./pipe/docker_engine'
      : 'unix:///var/run/docker.sock');

/** True when a local socket was found or a remote engine was configured. */
export const dockerEndpointResolved: boolean =
  !!socketPath || !!process.env.DOCKER_HOST?.trim();

export const docker = socketPath ? new Docker({ socketPath }) : new Docker();

export default docker;
