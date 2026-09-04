import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectNativeRuntime, describeDockerOnlyProject } from './nativeRuntime.js';

function tmpRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-native-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), '');
  return dir;
}

// QuantumNous/new-api, the repository that produced the "found nothing" report: a
// Go service whose root carries a Dockerfile. Docker-free mode genuinely cannot
// build it, but the message must not imply the clone came up empty.
test('a Go repo with a Dockerfile is described, not called empty', () => {
  const dir = tmpRepo(['Dockerfile', 'docker-compose.yml', 'go.mod', 'go.sum', 'main.go']);
  assert.equal(detectNativeRuntime(dir), null);
  const found = describeDockerOnlyProject(dir);
  assert.deepEqual(found, ['a Dockerfile', 'a Compose file', 'a Go module (go.mod)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a genuinely empty directory yields nothing to describe', () => {
  const dir = tmpRepo([]);
  assert.equal(detectNativeRuntime(dir), null);
  assert.deepEqual(describeDockerOnlyProject(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.NET is matched by suffix, since the manifest is named after the project', () => {
  const dir = tmpRepo(['MyApi.csproj']);
  assert.deepEqual(describeDockerOnlyProject(dir), ['a .NET project (MyApi.csproj)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('other ecosystems are named individually', () => {
  const dir = tmpRepo(['Cargo.toml', 'pom.xml', 'composer.json', 'Gemfile', 'mix.exs']);
  assert.deepEqual(describeDockerOnlyProject(dir), [
    'a Rust crate (Cargo.toml)',
    'a Maven project (pom.xml)',
    'a PHP project (composer.json)',
    'a Ruby project (Gemfile)',
    'an Elixir project (mix.exs)',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A Node repo is never routed to the Docker-only message, even next to a Dockerfile:
// detectNativeRuntime claims it first.
test('a Node repo still resolves to a native runtime', () => {
  const dir = tmpRepo(['package.json', 'Dockerfile']);
  assert.equal(detectNativeRuntime(dir), 'node');
  fs.rmSync(dir, { recursive: true, force: true });
});
