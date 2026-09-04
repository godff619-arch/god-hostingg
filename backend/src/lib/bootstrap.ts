// Fresh-install bootstrap secret — printed to server logs, never returned by a public API.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import prisma from './prisma.js';

const BOOTSTRAP_FILE = path.join(config.dataPath, '.bootstrap-secret');

/** Exclusive lock guarding the open (no-secret) first-account claim. */
const FIRST_ACCOUNT_LOCK = path.join(config.dataPath, '.first-account.lock');

/** A registration that crashed mid-flight must not brick setup forever. */
const LOCK_STALE_MS = 60_000;

export function getBootstrapSecretPath(): string {
  return BOOTSTRAP_FILE;
}

/**
 * Whether the first (owner) account has to present the server-printed bootstrap
 * secret.
 *
 * Off by default. On a one-click host — Coolify, Render, Railway, a plain
 * `docker run` — the operator often has no console to copy a secret from, and the
 * install is dead in the water: the panel cannot be claimed at all. Instead the
 * *first* signup wins and becomes OWNER, after which the window closes for good
 * (`/register` refuses once any user exists).
 *
 * Set `REQUIRE_BOOTSTRAP_SECRET=true` to restore the strict flow. Do that when the
 * URL is reachable by others before you have claimed it — otherwise whoever loads
 * /setup first owns the panel.
 */
export function isBootstrapRequired(): boolean {
  const raw = process.env.REQUIRE_BOOTSTRAP_SECRET?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Atomically claim the open first-account window (exclusive create). Returns the
 * lock path, or null when another registration already holds it — the same
 * one-winner guarantee `tryClaimBootstrapSecret` gives the secret flow.
 */
export function tryLockFirstAccount(): string | null {
  try {
    if (!fs.existsSync(config.dataPath)) {
      fs.mkdirSync(config.dataPath, { recursive: true });
    }
    try {
      fs.closeSync(fs.openSync(FIRST_ACCOUNT_LOCK, 'wx', 0o600));
      return FIRST_ACCOUNT_LOCK;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return null;
    }
    // Held: only steal it once it is clearly abandoned.
    if (Date.now() - fs.statSync(FIRST_ACCOUNT_LOCK).mtimeMs < LOCK_STALE_MS) return null;
    fs.unlinkSync(FIRST_ACCOUNT_LOCK);
    fs.closeSync(fs.openSync(FIRST_ACCOUNT_LOCK, 'wx', 0o600));
    return FIRST_ACCOUNT_LOCK;
  } catch {
    return null;
  }
}

/** Release the open first-account lock (both on success and on failure). */
export function releaseFirstAccountLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/** Ensure a bootstrap secret exists when setup is incomplete. Returns the secret (for logging). */
export function ensureBootstrapSecret(): string {
  if (!fs.existsSync(config.dataPath)) {
    fs.mkdirSync(config.dataPath, { recursive: true });
  }
  if (fs.existsSync(BOOTSTRAP_FILE)) {
    return fs.readFileSync(BOOTSTRAP_FILE, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(BOOTSTRAP_FILE, secret, { mode: 0o600 });
  return secret;
}

export function readBootstrapSecret(): string | null {
  try {
    if (!fs.existsSync(BOOTSTRAP_FILE)) return null;
    const value = fs.readFileSync(BOOTSTRAP_FILE, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function verifyBootstrapSecret(provided: string | undefined | null): boolean {
  if (!provided || typeof provided !== 'string') return false;
  const expected = readBootstrapSecret();
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Delete bootstrap secret after first admin is created (closes claim window). */
export function consumeBootstrapSecret(): void {
  try {
    if (fs.existsSync(BOOTSTRAP_FILE)) fs.unlinkSync(BOOTSTRAP_FILE);
  } catch {
    // ignore
  }
}

/** Atomically claim bootstrap secret for registration (exclusive rename). Returns claim path or null if lost. */
export function tryClaimBootstrapSecret(): string | null {
  if (!fs.existsSync(BOOTSTRAP_FILE)) return null;
  const claimName = `.claimed-${crypto.randomBytes(16).toString('hex')}`;
  const claimPath = path.join(config.dataPath, claimName);
  try {
    fs.renameSync(BOOTSTRAP_FILE, claimPath);
    return claimPath;
  } catch {
    return null;
  }
}

export function verifyBootstrapSecretAtPath(
  secretPath: string,
  provided: string | undefined | null
): boolean {
  if (!provided || typeof provided !== 'string') return false;
  try {
    if (!fs.existsSync(secretPath)) return false;
    const expected = fs.readFileSync(secretPath, 'utf8').trim();
    if (!expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Drop claim file after successful registration (secret must not be restorable). */
export function finalizeBootstrapClaim(claimPath: string): void {
  try {
    if (fs.existsSync(claimPath)) fs.unlinkSync(claimPath);
  } catch {
    // ignore
  }
}

/** Restore bootstrap secret file if registration fails after claim. */
export function abortBootstrapClaim(claimPath: string): void {
  try {
    if (fs.existsSync(claimPath) && !fs.existsSync(BOOTSTRAP_FILE)) {
      fs.renameSync(claimPath, BOOTSTRAP_FILE);
    }
  } catch {
    // ignore
  }
}

/**
 * Crash recovery: if registration died after rename(secret → .claimed-*),
 * restore the newest claim file so setup is not permanently bricked.
 * Only when no admin users exist yet.
 */
export function recoverStaleBootstrapClaims(): void {
  try {
    if (!fs.existsSync(config.dataPath)) return;
    if (fs.existsSync(BOOTSTRAP_FILE)) return;
    const claims = fs
      .readdirSync(config.dataPath)
      .filter((name) => name.startsWith('.claimed-'))
      .map((name) => path.join(config.dataPath, name))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (claims.length === 0) return;
    const newest = claims[0];
    fs.renameSync(newest, BOOTSTRAP_FILE);
    for (const orphan of claims.slice(1)) {
      try {
        fs.unlinkSync(orphan);
      } catch {
        /* ignore */
      }
    }
    console.warn(`[bootstrap] Restored stale claim ${path.basename(newest)} → .bootstrap-secret`);
  } catch (err) {
    console.warn('[bootstrap] Failed to recover stale claims:', err);
  }
}

/** Log bootstrap instructions when no users exist yet. */
export async function logBootstrapIfNeeded(): Promise<void> {
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      // Admin exists — drop leftover claim files from interrupted setup
      try {
        if (fs.existsSync(config.dataPath)) {
          for (const name of fs.readdirSync(config.dataPath)) {
            if (name.startsWith('.claimed-')) {
              fs.unlinkSync(path.join(config.dataPath, name));
            }
          }
        }
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    // DB missing / unrestored — still treat as fresh setup
  }

  recoverStaleBootstrapClaims();

  // Open claim (default): no secret to copy, so say plainly what to do next and
  // that the window shuts after the first account.
  if (!isBootstrapRequired()) {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  Fresh install — no account exists yet                           ║
║                                                                  ║
║  Open  /setup  and create the first account.                     ║
║  It becomes the platform OWNER, and registration then closes.    ║
║                                                                  ║
║  Claim it now: until you do, anyone who can reach this URL can.  ║
║  Set REQUIRE_BOOTSTRAP_SECRET=true to demand a printed secret.   ║
╚══════════════════════════════════════════════════════════════════╝
`);
    return;
  }

  const secret = ensureBootstrapSecret();
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  SECURITY: Fresh install — bootstrap secret required             ║
║                                                                  ║
║  Paste this into the Setup page (Register / Restore).            ║
║  It is NOT available via any public API.                         ║
║                                                                  ║
║  ${secret}
║                                                                  ║
║  Also on host: data/.bootstrap-secret                            ║
╚══════════════════════════════════════════════════════════════════╝
`);
}
