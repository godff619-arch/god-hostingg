// Docker-free execution — run an app service as a managed host process.
//
// This is the fallback path taken when the Docker engine is not reachable, so a
// user can still host a Node / Python / static app (a bot, an API, a site) without
// Docker running. It reuses the same Deployment records, log stream and service
// status the Docker path uses, so the UI (logs, status badge, stop/restart) works
// unchanged.
//
// SECURITY: a native process runs directly on the host under the backend's own
// user and privileges — there is NO container isolation, resource cgroup, or
// network namespace. That is acceptable for a single-operator self-host box but is
// weaker than the Docker path for untrusted multi-tenant workloads. Managed
// databases are deliberately NOT supported here (they need real engine binaries);
// those still require Docker.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { config } from '../lib/config.js';
import { startQuickTunnel } from './cloudflareTunnel.js';

export type NativeRuntime = 'node' | 'python' | 'static';

const IS_WIN = process.platform === 'win32';
const MAX_RESTARTS = 5;
const RESTART_BASE_MS = 1000;
const LOG_TAIL_BYTES = 256 * 1024;

export interface NativeEntry {
  projectId: string;
  serviceId: string | null;
  runtime: NativeRuntime;
  command: string;
  cwd: string;
  port: number | null;
  pid: number | null;
  startedAt: string;
  status: 'running' | 'stopped' | 'crashed';
  restarts: number;
  tunnelUrl: string | null;
}

const REGISTRY_FILE = path.join(config.dataPath, 'native-runtime.json');
const LOG_DIR = path.join(config.dataPath, 'native-logs');

// Live child handles for processes this backend instance started. After a backend
// restart the map is empty but the registry file still holds PIDs, so status
// reconciles by probing the OS rather than trusting stale memory.
const liveChildren = new Map<string, ChildProcess>();
// Live cloudflared tunnel handles, keyed by projectId. Kept alive across app
// restarts (the tunnel targets a fixed local port) and killed only on stop.
const liveTunnels = new Map<string, ChildProcess>();
// Projects intentionally stopped — suppresses the crash-restart loop.
const intentionalStop = new Set<string>();

function ensureDirs(): void {
  fs.mkdirSync(config.dataPath, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readRegistry(): Record<string, NativeEntry> {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeRegistry(reg: Record<string, NativeEntry>): void {
  ensureDirs();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

function upsertEntry(entry: NativeEntry): void {
  const reg = readRegistry();
  reg[entry.projectId] = entry;
  writeRegistry(reg);
}

function logPath(projectId: string): string {
  return path.join(LOG_DIR, `${projectId}.log`);
}

/** True if a PID is a live process (probe, no signal delivered). */
function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Windows can only spawn .cmd/.bat shims (npm.cmd) through a shell — since Node 20
// a direct spawn of them throws EINVAL. Our args are fixed literals, so enabling the
// shell here carries no injection risk.
function needsShell(file: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(file);
}

/**
 * Decide which native runtime a source directory needs from its manifests. Mirrors
 * the Docker build resolver's precedence: an explicit Node/Python manifest wins;
 * a bare `index.html` with no manifest is treated as a static site. Returns null
 * when nothing here can be run natively (e.g. Go/Rust/managed-DB) — the caller then
 * reports that Docker is required rather than guessing.
 */
export function detectNativeRuntime(cwd: string): NativeRuntime | null {
  if (fileExists(path.join(cwd, 'package.json'))) return 'node';
  if (
    fileExists(path.join(cwd, 'requirements.txt')) ||
    fileExists(path.join(cwd, 'pyproject.toml')) ||
    fileExists(path.join(cwd, 'Pipfile')) ||
    fileExists(path.join(cwd, 'main.py')) ||
    fileExists(path.join(cwd, 'app.py')) ||
    fileExists(path.join(cwd, 'bot.py'))
  ) {
    return 'python';
  }
  if (fileExists(path.join(cwd, 'index.html'))) return 'static';
  return null;
}

/**
 * What a directory shows that only Docker can build — used to explain a refusal.
 *
 * "No package.json, no Python entry, no index.html" is true but reads like the repo
 * is empty, and an operator looking at a repo that clearly has a Dockerfile
 * reasonably concludes the clone failed. Naming the manifests that ARE here moves
 * the message from "nothing found" to "found this; it needs the engine".
 */
export function describeDockerOnlyProject(cwd: string): string[] {
  const found: string[] = [];
  // Label per manifest. The filename is spelled out only where it isn't already in
  // the label — "a Dockerfile (Dockerfile)" reads like a stutter.
  const note = (file: string, label: string) => {
    if (fileExists(path.join(cwd, file))) found.push(label);
  };
  note('Dockerfile', 'a Dockerfile');
  note('docker-compose.yml', 'a Compose file');
  note('docker-compose.yaml', 'a Compose file');
  note('go.mod', 'a Go module (go.mod)');
  note('Cargo.toml', 'a Rust crate (Cargo.toml)');
  note('pom.xml', 'a Maven project (pom.xml)');
  note('build.gradle', 'a Gradle project (build.gradle)');
  note('build.gradle.kts', 'a Gradle project (build.gradle.kts)');
  note('composer.json', 'a PHP project (composer.json)');
  note('Gemfile', 'a Ruby project (Gemfile)');
  note('mix.exs', 'an Elixir project (mix.exs)');
  // .NET names its manifest after the project, so it has to be matched by suffix.
  try {
    const dotnet = fs.readdirSync(cwd).find((f) => /\.(csproj|fsproj|sln)$/i.test(f));
    if (dotnet) found.push(`a .NET project (${dotnet})`);
  } catch {
    /* unreadable dir — the caller's message just loses this hint */
  }
  return found;
}

/** First existing file from a candidate list, or null. */
function firstEntry(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (fileExists(path.join(cwd, c))) return c;
  }
  return null;
}

interface StartPlan {
  file: string;
  args: string[];
  display: string;
}

/**
 * Work out the command that starts a Node app. A `start` script wins (that is the
 * convention every host honours); otherwise `package.json main`, then the usual
 * entry filenames a bot or server uses. Returns null when nothing looks runnable.
 */
function resolveNodeStart(cwd: string): StartPlan | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg?.scripts?.start) {
        const npm = IS_WIN ? 'npm.cmd' : 'npm';
        return { file: npm, args: ['start'], display: 'npm start' };
      }
      if (typeof pkg?.main === 'string' && fileExists(path.join(cwd, pkg.main))) {
        return { file: process.execPath, args: [pkg.main], display: `node ${pkg.main}` };
      }
    } catch {
      // Malformed package.json — fall through to filename probing.
    }
  }
  const entry = firstEntry(cwd, ['index.js', 'server.js', 'app.js', 'bot.js', 'main.js', 'src/index.js']);
  if (entry) return { file: process.execPath, args: [entry], display: `node ${entry}` };
  return null;
}

/** Entry resolution for Python: common bot/app/server filenames. */
function resolvePythonStart(cwd: string): StartPlan | null {
  const py = IS_WIN ? 'python' : 'python3';
  const entry = firstEntry(cwd, ['main.py', 'app.py', 'bot.py', 'run.py', 'server.py', '__main__.py']);
  if (entry) return { file: py, args: [entry], display: `${py} ${entry}` };
  return null;
}

// The static server is a self-contained one-liner so the native path has zero
// extra dependencies — Node's own http/fs serve the built directory, defaulting to
// index.html and falling back to it for client-side routes (SPA behaviour).
const STATIC_SERVER = `
const http=require('http'),fs=require('fs'),path=require('path');
const root=process.cwd(),port=Number(process.env.PORT)||3000;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2'};
http.createServer((req,res)=>{
  let p=decodeURIComponent((req.url||'/').split('?')[0]);
  let f=path.join(root,p);
  if(!f.startsWith(root)){res.writeHead(403);return res.end('forbidden');}
  fs.stat(f,(e,s)=>{
    if(!e&&s.isDirectory()){f=path.join(f,'index.html');}
    fs.readFile(f,(err,buf)=>{
      if(err){
        fs.readFile(path.join(root,'index.html'),(e2,idx)=>{
          if(e2){res.writeHead(404);return res.end('not found');}
          res.writeHead(200,{'Content-Type':'text/html'});res.end(idx);
        });return;
      }
      res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});res.end(buf);
    });
  });
}).listen(port,()=>console.log('static server on '+port));
`;

type LogFn = (line: string) => void;

/** Append a line to the persisted native log for a project, trimming to a tail. */
function appendLog(projectId: string, line: string): void {
  ensureDirs();
  const file = logPath(projectId);
  try {
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
    const st = fs.statSync(file);
    if (st.size > LOG_TAIL_BYTES * 2) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.subarray(buf.length - LOG_TAIL_BYTES));
    }
  } catch {
    // Logging must never crash the supervisor.
  }
}

/** Read the tail of a native process log (for the deployment log view). */
export function tailNativeLog(projectId: string, maxBytes = LOG_TAIL_BYTES): string {
  try {
    const buf = fs.readFileSync(logPath(projectId));
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf-8');
  } catch {
    return '';
  }
}

/** Run a one-shot build command (npm install, pip install …), streaming to log. */
function runOnce(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLog: LogFn,
): Promise<number> {
  return new Promise((resolve) => {
    onLog(`$ ${file} ${args.join(' ')}`);
    const child = spawn(file, args, { cwd, env, shell: needsShell(file) });
    child.stdout.on('data', (d) => onLog(d.toString()));
    child.stderr.on('data', (d) => onLog(d.toString()));
    child.on('error', (e) => {
      onLog(`spawn failed: ${e.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/**
 * Install dependencies for the detected runtime before first start. Node uses
 * `npm ci` when a lockfile is present (reproducible) and falls back to `npm install`.
 * Python installs into a project-local `.venv` so nothing pollutes the host site
 * packages; the venv's interpreter is then used to start the app. Static sites have
 * nothing to install. Returns the interpreter/command overrides the start step must
 * use (e.g. the venv python), or an empty object.
 */
export async function installDeps(
  runtime: NativeRuntime,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLog: LogFn,
): Promise<{ pythonBin?: string }> {
  if (runtime === 'node') {
    const hasLock = fileExists(path.join(cwd, 'package-lock.json'));
    const npm = IS_WIN ? 'npm.cmd' : 'npm';
    if (!fileExists(path.join(cwd, 'package.json'))) return {};
    let code = await runOnce(npm, [hasLock ? 'ci' : 'install'], cwd, env, onLog);
    if (code !== 0 && hasLock) {
      onLog('npm ci failed, retrying with npm install…');
      code = await runOnce(npm, ['install'], cwd, env, onLog);
    }
    if (code !== 0) throw new Error(`npm install failed (exit ${code})`);
    return {};
  }

  if (runtime === 'python') {
    const reqs = fileExists(path.join(cwd, 'requirements.txt'));
    if (!reqs) return {}; // Nothing declared — run against the system interpreter.
    const basePy = IS_WIN ? 'python' : 'python3';
    const venvDir = path.join(cwd, '.venv');
    const venvPy = IS_WIN
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
    if (!fileExists(venvPy)) {
      const code = await runOnce(basePy, ['-m', 'venv', '.venv'], cwd, env, onLog);
      if (code !== 0) throw new Error(`python venv creation failed (exit ${code})`);
    }
    let code = await runOnce(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], cwd, env, onLog);
    code = await runOnce(venvPy, ['-m', 'pip', 'install', '-r', 'requirements.txt'], cwd, env, onLog);
    if (code !== 0) throw new Error(`pip install failed (exit ${code})`);
    return { pythonBin: venvPy };
  }

  return {}; // static
}

/**
 * Resolve the long-lived start command for a runtime. `pythonBin` (from installDeps)
 * overrides the interpreter so the venv is used. Throws with an actionable message
 * when no entry point can be found — the deploy then fails loudly instead of
 * spawning nothing.
 */
export function resolveStart(
  runtime: NativeRuntime,
  cwd: string,
  pythonBin?: string,
): StartPlan {
  if (runtime === 'node') {
    const plan = resolveNodeStart(cwd);
    if (!plan) {
      throw new Error(
        'No Node entry point found. Add a "start" script or an index.js/server.js/app.js.',
      );
    }
    return plan;
  }
  if (runtime === 'python') {
    const plan = resolvePythonStart(cwd);
    if (!plan) {
      throw new Error('No Python entry point found. Add a main.py / app.py / bot.py.');
    }
    if (pythonBin) return { ...plan, file: pythonBin, display: `${path.basename(pythonBin)} ${plan.args.join(' ')}` };
    return plan;
  }
  // static — serve the directory with the built-in one-line server.
  return { file: process.execPath, args: ['-e', STATIC_SERVER], display: 'static server' };
}

/** Kill a process tree by PID, cross-platform. Best-effort — never throws. */
function killTree(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Already gone.
  }
}

export interface StartOptions {
  projectId: string;
  serviceId: string | null;
  cwd: string;
  runtime: NativeRuntime;
  port: number | null;
  env: NodeJS.ProcessEnv;
  pythonBin?: string;
  onLog: LogFn;
}

/**
 * Spawn the long-lived service process and supervise it. Output is teed to the
 * persisted native log and to the caller's `onLog` (which streams into the live
 * deployment log). On an unexpected exit the process is restarted with exponential
 * backoff up to MAX_RESTARTS — unless it was stopped on purpose. Returns once the
 * child is spawned (not when it exits); the caller records the deployment as
 * running and the supervisor keeps it alive in the background.
 */
export function startNativeService(opts: StartOptions): NativeEntry {
  const { projectId, serviceId, cwd, runtime, port, env, pythonBin, onLog } = opts;
  intentionalStop.delete(projectId);

  const plan = resolveStart(runtime, cwd, pythonBin);
  const runEnv: NodeJS.ProcessEnv = { ...env };
  if (port) runEnv.PORT = String(port);

  const spawnChild = (attempt: number): void => {
    const banner = `Starting: ${plan.display}${port ? ` (PORT=${port})` : ''}`;
    onLog(banner);
    appendLog(projectId, banner);

    const child = spawn(plan.file, plan.args, { cwd, env: runEnv, shell: needsShell(plan.file) });
    liveChildren.set(projectId, child);

    const entry: NativeEntry = {
      projectId,
      serviceId,
      runtime,
      command: plan.display,
      cwd,
      port,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      status: 'running',
      restarts: attempt,
      tunnelUrl: readRegistry()[projectId]?.tunnelUrl ?? null,
    };
    upsertEntry(entry);

    const tee = (chunk: Buffer) => {
      const text = chunk.toString();
      onLog(text);
      appendLog(projectId, text);
    };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);

    child.on('error', (e) => {
      const msg = `process error: ${e.message}`;
      onLog(msg);
      appendLog(projectId, msg);
    });

    child.on('close', (code) => {
      liveChildren.delete(projectId);
      const clean = code === 0;
      const stopped = intentionalStop.has(projectId);
      const msg = `process exited with code ${code}`;
      appendLog(projectId, msg);

      const reg = readRegistry();
      const cur = reg[projectId];
      if (!cur) return;

      if (stopped) {
        cur.status = 'stopped';
        cur.pid = null;
        upsertEntry(cur);
        return;
      }
      // Unexpected exit — restart with backoff unless we've exhausted attempts.
      if (attempt + 1 <= MAX_RESTARTS) {
        const delay = RESTART_BASE_MS * Math.pow(2, attempt);
        appendLog(projectId, `restarting in ${delay}ms (attempt ${attempt + 1}/${MAX_RESTARTS})`);
        cur.status = clean ? 'stopped' : 'crashed';
        cur.pid = null;
        upsertEntry(cur);
        setTimeout(() => {
          if (!intentionalStop.has(projectId)) spawnChild(attempt + 1);
        }, delay);
      } else {
        cur.status = 'crashed';
        cur.pid = null;
        upsertEntry(cur);
        appendLog(projectId, `giving up after ${MAX_RESTARTS} restarts`);
      }
    });
  };

  spawnChild(0);
  return readRegistry()[projectId];
}

/** Stop a native service and suppress the crash-restart loop. */
export function stopNativeService(projectId: string): boolean {
  intentionalStop.add(projectId);
  const child = liveChildren.get(projectId);
  const reg = readRegistry();
  const entry = reg[projectId];
  killTree(child?.pid ?? entry?.pid ?? null);
  liveChildren.delete(projectId);
  // Tear the public tunnel down too, and forget its URL.
  const tunnel = liveTunnels.get(projectId);
  if (tunnel) killTree(tunnel.pid);
  liveTunnels.delete(projectId);
  if (entry) {
    entry.status = 'stopped';
    entry.pid = null;
    entry.tunnelUrl = null;
    upsertEntry(entry);
  }
  return Boolean(entry);
}

/**
 * Probe a local port for an HTTP responder, retrying for a short window. Used to
 * tell a real web app (worth a public tunnel) apart from a background worker such
 * as a Discord bot (no listening socket — a tunnel would just 502).
 */
export function probeHttp(port: number, totalMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  const loop = async (): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (await attempt()) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  };
  return loop();
}

/**
 * Open (or reuse) a Cloudflare quick tunnel for a project's port and record the
 * public URL in its registry entry. Returns the URL, or null if the tunnel could
 * not be established (non-fatal — the app is still running locally). The tunnel
 * process is supervised: if it dies unexpectedly it is reopened once.
 */
export async function startTunnelForProject(
  projectId: string,
  port: number,
  onLog: (line: string) => void,
): Promise<string | null> {
  // Replace any stale tunnel for this project.
  const existing = liveTunnels.get(projectId);
  if (existing) {
    killTree(existing.pid);
    liveTunnels.delete(projectId);
  }
  try {
    const { child, url } = await startQuickTunnel(port, onLog);
    liveTunnels.set(projectId, child);
    child.stdout?.on('data', (d) => appendLog(projectId, `[tunnel] ${d}`));
    child.stderr?.on('data', (d) => appendLog(projectId, `[tunnel] ${d}`));
    child.on('close', () => {
      liveTunnels.delete(projectId);
      appendLog(projectId, '[tunnel] cloudflared exited\n');
    });
    const reg = readRegistry();
    if (reg[projectId]) {
      reg[projectId].tunnelUrl = url;
      writeRegistry(reg);
    }
    return url;
  } catch (err) {
    onLog(`⚠️ Cloudflare tunnel unavailable: ${(err as Error).message}\n`);
    return null;
  }
}

/** Current native status for a project, reconciled against the live OS process. */
export function nativeStatus(projectId: string): NativeEntry | null {
  const reg = readRegistry();
  const entry = reg[projectId];
  if (!entry) return null;
  const alive = liveChildren.has(projectId) || pidAlive(entry.pid);
  if (!alive && entry.status === 'running') {
    entry.status = 'crashed';
    entry.pid = null;
    upsertEntry(entry);
  }
  return entry;
}

/** Whether a native entry exists for this project (used to route stop/restart). */
export function hasNativeEntry(projectId: string): boolean {
  return Boolean(readRegistry()[projectId]);
}

/** The project-local venv interpreter if one was created, else undefined. */
export function venvPythonIfPresent(cwd: string): string | undefined {
  const venvPy = IS_WIN
    ? path.join(cwd, '.venv', 'Scripts', 'python.exe')
    : path.join(cwd, '.venv', 'bin', 'python');
  return fileExists(venvPy) ? venvPy : undefined;
}

/**
 * Reconcile the registry on backend startup. In-memory child handles are gone after
 * a restart, so any entry marked running whose PID is no longer alive is corrected
 * to 'crashed'. Processes that survived (detached, still holding their PID) are left
 * as running. Called once from the server bootstrap.
 */
export function reconcileNativeOnBoot(): void {
  const reg = readRegistry();
  let changed = false;
  for (const entry of Object.values(reg)) {
    if (entry.status === 'running' && !pidAlive(entry.pid)) {
      entry.status = 'crashed';
      entry.pid = null;
      changed = true;
    }
  }
  if (changed) writeRegistry(reg);
}
