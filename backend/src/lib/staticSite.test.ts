import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveStaticSite, isServerRoute, isBuiltAssetPath } from './staticSite.js';

function tmpTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docklift-static-'));
}

test('resolveStaticSite finds a built SPA next to the server, else returns null', () => {
  const root = tmpTree();
  const serverDir = path.join(root, 'backend', 'dist');
  fs.mkdirSync(serverDir, { recursive: true });

  // Nothing built yet → single-container mode stays off (compose image behaviour)
  assert.equal(resolveStaticSite(serverDir), null);

  // Baked in by the repo-root Dockerfile: backend/public
  const baked = path.join(root, 'backend', 'public');
  fs.mkdirSync(baked, { recursive: true });
  fs.writeFileSync(path.join(baked, 'index.html'), '<!doctype html>');
  assert.equal(resolveStaticSite(serverDir), baked);

  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveStaticSite falls back to a monorepo frontend build', () => {
  const root = tmpTree();
  const serverDir = path.join(root, 'backend', 'dist');
  const frontend = path.join(root, 'frontend', 'dist');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(frontend, { recursive: true });
  fs.writeFileSync(path.join(frontend, 'index.html'), '<!doctype html>');

  assert.equal(resolveStaticSite(serverDir), frontend);

  fs.rmSync(root, { recursive: true, force: true });
});

test('STATIC_PATH overrides the search and is honoured verbatim', () => {
  const root = tmpTree();
  const custom = path.join(root, 'site');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'index.html'), '<!doctype html>');

  const previous = process.env.STATIC_PATH;
  process.env.STATIC_PATH = custom;
  try {
    assert.equal(resolveStaticSite(path.join(root, 'elsewhere')), custom);
    // An explicit path that holds no build must not silently fall back
    process.env.STATIC_PATH = path.join(root, 'empty');
    assert.equal(resolveStaticSite(path.join(root, 'elsewhere')), null);
  } finally {
    if (previous === undefined) delete process.env.STATIC_PATH;
    else process.env.STATIC_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the SPA fallback never shadows API, WebSocket or probe routes', () => {
  for (const p of ['/api', '/api/health', '/api/projects/1', '/ws', '/ws/terminal', '/health/live']) {
    assert.equal(isServerRoute(p), true, p);
  }
  for (const p of ['/', '/setup', '/login', '/project/abc', '/apidocs', '/healthz']) {
    assert.equal(isServerRoute(p), false, p);
  }
});

test('missing build assets 404 instead of returning the SPA shell', () => {
  assert.equal(isBuiltAssetPath('/assets/index-abc123.js'), true);
  assert.equal(isBuiltAssetPath('/assets/'), true);
  assert.equal(isBuiltAssetPath('/logo.png'), false);
  assert.equal(isBuiltAssetPath('/project/assets/x'), false);
});
