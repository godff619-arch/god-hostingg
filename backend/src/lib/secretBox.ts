// Authenticated encryption for credentials we must store but never disclose
// (registry passwords, webhook signing secrets, observability API keys).
//
// Values are sealed with AES-256-GCM under a key persisted alongside the JWT
// secret in `data/.secrets` (mode 0600). The API returns only presence
// metadata — `open()` exists for outbound calls the server itself makes, never
// to echo a secret back to a client.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const SECRETS_FILE = path.join(config.dataPath, '.secrets');
const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/** Load (or create) the 32-byte data key. Env `SECRET_BOX_KEY` (hex) wins. */
function dataKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.SECRET_BOX_KEY?.trim();
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) {
    cachedKey = Buffer.from(fromEnv, 'hex');
    return cachedKey;
  }

  let store: Record<string, string> = {};
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      store = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Record<string, string>;
    }
  } catch {
    store = {};
  }

  const existing = store.secretBoxKey;
  if (existing && /^[0-9a-f]{64}$/i.test(existing)) {
    cachedKey = Buffer.from(existing, 'hex');
    return cachedKey;
  }

  const generated = crypto.randomBytes(32);
  store.secretBoxKey = generated.toString('hex');
  try {
    if (!fs.existsSync(config.dataPath)) fs.mkdirSync(config.dataPath, { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: sealed values simply won't survive a restart.
    console.warn('[secretBox] could not persist data key — sealed values reset on restart');
  }
  cachedKey = generated;
  return cachedKey;
}

/** Seal a plaintext secret. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, dataKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join(
    '.',
  );
}

/** Open a sealed value. Returns null when the blob is malformed or the key changed. */
export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv(
      ALGO,
      dataKey(),
      Buffer.from(parts[1], 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

/** Display form for a stored secret — presence only, never any plaintext bytes. */
export function maskedHint(sealed: string | null | undefined): string {
  return sealed ? '••••••••••••' : '';
}
