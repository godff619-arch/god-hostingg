// Cloudflare Quick Tunnel — give a locally-hosted native process a public HTTPS URL
// with zero configuration and no Cloudflare account.
//
// `cloudflared tunnel --url http://localhost:<port>` opens a TryCloudflare quick
// tunnel and prints a `https://<random>.trycloudflare.com` address that proxies to
// the local port. We auto-download the `cloudflared` binary on first use (into
// dataPath/bin) so the operator never has to install anything by hand — this is the
// "just run it and get a link" path the Docker-free runtime uses.
//
// Quick tunnels are ephemeral (the hostname changes each run) and rate-limited —
// they are perfect for demos / bots / previews. For a stable custom domain a named
// tunnel with a token is the upgrade path, but that needs an account so it is not
// the default here.

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { config } from '../lib/config.js';

const IS_WIN = process.platform === 'win32';
const BIN_DIR = path.join(config.dataPath, 'bin');
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

type LogFn = (line: string) => void;

/** Resolve the cloudflared release asset name for this OS/arch. */
function assetName(): string | null {
  const arch = process.arch;
  if (IS_WIN) return arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  if (process.platform === 'linux') {
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
    if (arch === 'arm') return 'cloudflared-linux-arm';
    return 'cloudflared-linux-amd64';
  }
  if (process.platform === 'darwin') return null; // macOS ships a .tgz — use `brew install cloudflared`.
  return null;
}

function localBinPath(): string {
  return path.join(BIN_DIR, IS_WIN ? 'cloudflared.exe' : 'cloudflared');
}

/** True if a `cloudflared` is already on PATH (operator installed it themselves). */
function cloudflaredOnPath(): boolean {
  try {
    const r = spawnSync(IS_WIN ? 'cloudflared.exe' : 'cloudflared', ['--version'], {
      stdio: 'ignore',
      shell: false,
      timeout: 8000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure a usable cloudflared binary and return the command to invoke it. Prefers
 * one already on PATH; otherwise downloads the release asset for this platform into
 * dataPath/bin on first use and reuses it thereafter. Throws with an actionable
 * message when the platform has no prebuilt asset (e.g. macOS → brew).
 */
export async function ensureCloudflared(onLog: LogFn): Promise<string> {
  if (cloudflaredOnPath()) return IS_WIN ? 'cloudflared.exe' : 'cloudflared';

  const local = localBinPath();
  if (fs.existsSync(local)) return local;

  const asset = assetName();
  if (!asset) {
    throw new Error(
      'cloudflared is not installed and no auto-download is available for this OS. ' +
        'Install it manually (e.g. `brew install cloudflared`) and redeploy.',
    );
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  onLog(`⬇️  Installing cloudflared (first run) from ${url}\n`);

  const res = await fetch(url); // global fetch follows GitHub's redirect to the CDN
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download cloudflared: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = local + '.download';
  fs.writeFileSync(tmp, buf);
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, local);
  onLog(`✅ cloudflared installed (${(buf.length / 1_048_576).toFixed(1)} MB)\n`);
  return local;
}

/**
 * Open a Cloudflare quick tunnel to a local port. Resolves once the public
 * trycloudflare.com URL is parsed from cloudflared's output (or rejects on timeout).
 * The returned child keeps running — the caller owns its lifecycle and must kill it
 * when the service stops.
 */
export async function startQuickTunnel(
  port: number,
  onLog: LogFn,
  timeoutMs = 30_000,
): Promise<{ child: ChildProcess; url: string }> {
  const bin = await ensureCloudflared(onLog);
  onLog(`🌐 Opening Cloudflare tunnel to http://localhost:${port} …\n`);

  const child = spawn(
    bin,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    { shell: false },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('Timed out waiting for the Cloudflare tunnel URL'));
    }, timeoutMs);

    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(TRYCF_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    };
    // cloudflared prints the URL banner to stderr.
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (code ${code})`));
    });
  });
}
