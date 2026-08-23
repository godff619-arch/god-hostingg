// Railpack binary resolution — with auto-install for non-Docker installs.
//
// Railpack is the automatic application builder used when a repository has no
// Dockerfile. The production backend image bakes a pinned binary in (see
// backend/Dockerfile), but the control plane can also run natively (`npm run dev`,
// bare-metal install), and there `railpack` is simply not on PATH — every Railpack
// deployment then dies with a cryptic `spawn railpack ENOENT`.
//
// So we resolve it the same way the Cloudflare tunnel resolves `cloudflared`:
// prefer an operator-installed binary on PATH, else download the pinned release
// asset once into dataPath/bin and reuse it. The version is pinned deliberately
// (never floated) so a native install builds exactly like the Docker image.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { config } from '../lib/config.js';

/** Keep in sync with ARG RAILPACK_VERSION in backend/Dockerfile. */
export const RAILPACK_VERSION = '0.33.0';

const IS_WIN = process.platform === 'win32';
const BIN_DIR = path.join(config.dataPath, 'bin');
const EXE = IS_WIN ? 'railpack.exe' : 'railpack';

type LogFn = (line: string) => void;

/** Release asset for this OS/arch, or null when upstream publishes none. */
function assetName(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) return null;
  const v = RAILPACK_VERSION;
  // musl binaries are static, so the Linux asset also runs on glibc hosts.
  if (process.platform === 'linux') return `railpack-v${v}-${arch}-unknown-linux-musl.tar.gz`;
  if (process.platform === 'darwin') return `railpack-v${v}-${arch}-apple-darwin.tar.gz`;
  if (IS_WIN) return `railpack-v${v}-${arch}-pc-windows-msvc.zip`;
  return null;
}

function localBinPath(): string {
  return path.join(BIN_DIR, EXE);
}

/** True when `railpack --version` succeeds for the given command. */
function versionOk(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false, timeout: 15_000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Extract the downloaded archive into BIN_DIR. Both the tarball and the Windows
 * zip contain the bare executable at the archive root, so `tar` (bsdtar on
 * Windows 10+, which also reads zip) is enough — no extra dependency.
 */
function extract(archive: string): void {
  const args = archive.endsWith('.zip') ? ['-xf', archive] : ['-xzf', archive];
  const r = spawnSync('tar', [...args, '-C', BIN_DIR], {
    stdio: 'ignore',
    shell: false,
    timeout: 120_000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(
      `Failed to extract ${path.basename(archive)} (tar exited ${r.status ?? 'with an error'}). ` +
        'Install railpack manually so it is on PATH, or add a Dockerfile to the repository.',
    );
  }
}

/**
 * Ensure a usable railpack binary and return the command to invoke it. Prefers one
 * already on PATH; otherwise downloads the pinned release asset into dataPath/bin on
 * first use and reuses it thereafter. Throws with an actionable message when the
 * platform has no published asset.
 */
export async function ensureRailpack(onLog: LogFn): Promise<string> {
  if (versionOk(EXE)) return EXE;

  const local = localBinPath();
  if (fs.existsSync(local) && versionOk(local)) return local;

  const asset = assetName();
  if (!asset) {
    throw new Error(
      `railpack is not installed and no prebuilt binary is published for ${process.platform}/${process.arch}. ` +
        'Install it manually so it is on PATH, or add a Dockerfile to the repository.',
    );
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}`;
  onLog(`⬇️  Installing railpack v${RAILPACK_VERSION} (first run) from ${url}\n`);

  const res = await fetch(url); // global fetch follows GitHub's redirect to the CDN
  if (!res.ok) {
    throw new Error(`Failed to download railpack: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const archive = path.join(BIN_DIR, asset);
  fs.writeFileSync(archive, buf);
  try {
    extract(archive);
  } finally {
    try {
      fs.unlinkSync(archive);
    } catch {
      /* leave the archive behind rather than failing the build */
    }
  }

  if (!IS_WIN) {
    try {
      fs.chmodSync(local, 0o755);
    } catch {
      /* extracted mode is usually already executable */
    }
  }
  if (!versionOk(local)) {
    throw new Error(
      'railpack was downloaded but does not run on this host. ' +
        'Install it manually so it is on PATH, or add a Dockerfile to the repository.',
    );
  }
  onLog(`✅ railpack v${RAILPACK_VERSION} installed (${(buf.length / 1_048_576).toFixed(1)} MB)\n`);
  return local;
}
