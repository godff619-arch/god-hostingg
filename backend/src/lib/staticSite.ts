// Single-container mode: let the API also serve the built dashboard.
//
// The docker-compose stack keeps the SPA in its own nginx container behind the
// docklift-nginx gateway, so it needs nothing from here. But every "give me one
// container on one port" host — Coolify, Render, Railway, a bare `docker run` —
// can expose only a single port, and a panel whose UI lives on another port is
// simply unreachable there.
//
// So this is additive and self-disabling: when a built SPA is found next to the
// API, Express serves it; when there is none (the compose backend image ships no
// frontend build) the resolver returns null and the API behaves exactly as before.

import fs from 'fs';
import path from 'path';

/**
 * Directories probed for a built SPA, relative to the running server file
 * (`backend/dist` in the image, `backend/src` under tsx). `STATIC_PATH`
 * overrides the search entirely.
 */
const CANDIDATES = [
  path.join('..', 'public'), // baked in by the repo-root Dockerfile
  path.join('..', '..', 'frontend', 'dist'), // monorepo checkout / native install
];

/** Absolute path of a built SPA (a directory containing index.html), or null. */
export function resolveStaticSite(baseDir: string): string | null {
  const explicit = process.env.STATIC_PATH?.trim();
  const candidates = explicit ? [explicit] : CANDIDATES;
  for (const candidate of candidates) {
    const dir = path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      /* unreadable candidate — try the next one */
    }
  }
  return null;
}

/** True for requests the SPA fallback must never answer (API, WS, probes). */
export function isServerRoute(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/ws' ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/health/')
  );
}

/**
 * True for Vite build output. A miss here has to 404: answering a stale
 * `/assets/index-<hash>.js` with index.html makes the browser parse HTML as
 * JavaScript ("Unexpected token '<'") instead of reporting the real problem.
 */
export function isBuiltAssetPath(pathname: string): boolean {
  return pathname.startsWith('/assets/');
}
