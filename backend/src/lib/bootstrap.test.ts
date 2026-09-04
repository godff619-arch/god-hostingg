import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  isBootstrapRequired,
  tryLockFirstAccount,
  releaseFirstAccountLock,
} from './bootstrap.js';
import { config } from './config.js';

const LOCK_PATH = path.join(config.dataPath, '.first-account.lock');

function withRequireEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.REQUIRE_BOOTSTRAP_SECRET;
  if (value === undefined) delete process.env.REQUIRE_BOOTSTRAP_SECRET;
  else process.env.REQUIRE_BOOTSTRAP_SECRET = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.REQUIRE_BOOTSTRAP_SECRET;
    else process.env.REQUIRE_BOOTSTRAP_SECRET = prev;
  }
}

test('the bootstrap secret is opt-in — a one-click host must stay claimable', () => {
  withRequireEnv(undefined, () => assert.equal(isBootstrapRequired(), false));
  withRequireEnv('', () => assert.equal(isBootstrapRequired(), false));
  for (const on of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    withRequireEnv(on, () => assert.equal(isBootstrapRequired(), true, on));
  }
  for (const off of ['0', 'false', 'no', 'maybe']) {
    withRequireEnv(off, () => assert.equal(isBootstrapRequired(), false, off));
  }
});

test('only one registration can hold the open first-account claim', () => {
  fs.mkdirSync(config.dataPath, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  try {
    const first = tryLockFirstAccount();
    assert.equal(first, LOCK_PATH);
    // A concurrent signup must lose rather than create a second owner
    assert.equal(tryLockFirstAccount(), null);

    releaseFirstAccountLock(first!);
    assert.equal(fs.existsSync(LOCK_PATH), false);
    // Released: the next attempt (failed registration, retry) can claim again
    const second = tryLockFirstAccount();
    assert.equal(second, LOCK_PATH);
    releaseFirstAccountLock(second!);
    // Releasing twice is a no-op, never a throw
    releaseFirstAccountLock(second!);
  } finally {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  }
});

test('an abandoned claim is stolen, so a crash mid-setup cannot brick the install', () => {
  fs.mkdirSync(config.dataPath, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  try {
    assert.equal(tryLockFirstAccount(), LOCK_PATH);
    // Backdate past the 60s staleness window — as if the process died holding it
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(LOCK_PATH, old, old);
    assert.equal(tryLockFirstAccount(), LOCK_PATH);
    // Fresh again after the steal, so a third caller still loses
    assert.equal(tryLockFirstAccount(), null);
  } finally {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  }
});
