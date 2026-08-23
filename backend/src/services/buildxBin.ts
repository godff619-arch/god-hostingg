// Docker Buildx resolution — with auto-install for hosts that ship a bare Docker CLI.
//
// Railpack hands its build plan to BuildKit through `docker buildx build`, and
// Dockerfile builds need it too as soon as a build secret is configured. Plenty of
// hosts (CodeSandbox, minimal VPS images, Docker CE without the plugin package)
// have a working daemon but no buildx plugin, and every Railpack deployment then
// fails on "unknown command: buildx".
//
// Buildx is an ordinary Docker CLI plugin: a single binary in
// `$DOCKER_CONFIG/cli-plugins/docker-buildx` (default `~/.docker/cli-plugins`). So we
// install it the same way cloudflared and railpack are handled — probe first, then
// download the pinned release once and verify it actually runs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { dockerBin } from '../lib/dockerBin.js';

/** Pinned deliberately so every host builds with the same buildx. */
export const BUILDX_VERSION = '0.36.1';

const IS_WIN = process.platform === 'win32';
const PLUGIN_NAME = IS_WIN ? 'docker-buildx.exe' : 'docker-buildx';

type LogFn = (line: string) => void;

/** Where the Docker CLI looks for plugins (honours DOCKER_CONFIG). */
function cliPluginsDir(): string {
  const base = process.env.DOCKER_CONFIG?.trim() || path.join(os.homedir(), '.docker');
  return path.join(base, 'cli-plugins');
}

/** Release asset for this OS/arch, or null when upstream publishes none. */
function assetName(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!arch) return null;
  const platform =
    process.platform === 'linux'
      ? 'linux'
      : process.platform === 'darwin'
        ? 'darwin'
        : IS_WIN
          ? 'windows'
          : null;
  if (!platform) return null;
  return `buildx-v${BUILDX_VERSION}.${platform}-${arch}${IS_WIN ? '.exe' : ''}`;
}

/** True when the Docker CLI can already run buildx. */
export function buildxAvailable(): boolean {
  try {
    const r = spawnSync(dockerBin(), ['buildx', 'version'], {
      stdio: 'ignore',
      shell: false,
      timeout: 20_000,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const MANUAL_HINT =
  'Install the Docker Buildx plugin manually (e.g. the docker-buildx-plugin package) ' +
  'or add a Dockerfile to the repository.';

/**
 * Ensure `docker buildx` works, installing the pinned plugin on first use when it is
 * missing. Throws with an actionable message when it cannot be made to work, so a
 * deployment fails with the real reason instead of a bare "unknown command".
 */
export async function ensureBuildx(onLog: LogFn): Promise<void> {
  if (buildxAvailable()) return;

  const asset = assetName();
  if (!asset) {
    throw new Error(
      `Docker Buildx is required but no prebuilt plugin is published for ${process.platform}/${process.arch}. ${MANUAL_HINT}`,
    );
  }

  const dir = cliPluginsDir();
  const target = path.join(dir, PLUGIN_NAME);
  const url = `https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/${asset}`;
  onLog(`⬇️  Installing Docker Buildx v${BUILDX_VERSION} (first run) from ${url}\n`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await fetch(url); // global fetch follows GitHub's redirect to the CDN
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${target}.download`;
    fs.writeFileSync(tmp, buf);
    if (!IS_WIN) fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
    onLog(`✅ Docker Buildx installed (${(buf.length / 1_048_576).toFixed(1)} MB)\n`);
  } catch (err) {
    throw new Error(
      `Docker Buildx is not available and could not be installed automatically ` +
        `(${(err as Error)?.message || 'download failed'}). ${MANUAL_HINT}`,
    );
  }

  if (!buildxAvailable()) {
    throw new Error(
      `Docker Buildx was installed to ${target} but the Docker CLI still cannot run it. ${MANUAL_HINT}`,
    );
  }
}
