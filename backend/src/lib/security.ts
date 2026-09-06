/**
 * Security layer — sessions, sign-in attempts and machine API keys (spec §29–§31).
 *
 * The three tables this module owns (`admin_sessions`, `login_attempts`,
 * `admin_api_keys`) shipped in the billing-core migration but nothing wrote to
 * them, so the security dashboard the spec asks for would have been three empty
 * tables and a chart of zeroes. This is the writer.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT
 * ---------------------------------
 * Sessions are recorded for accounts that reach the admin panel, not for every
 * customer login. The point of §30 is "an operator can see their devices and kill
 * one"; a row per customer sign-in would turn the table into a traffic log and buy
 * nothing, because a customer session is already killable two ways that work today
 * (suspend the account, or bump `passwordChangedAt`).
 *
 * Sign-in *attempts* are recorded for everyone, success and failure alike. That is
 * the one table where the interesting rows are the ones nobody chose to make.
 *
 * TOKENS ARE NEVER STORED
 * -----------------------
 * A session row holds `sha256(jwt)`; an API key row holds `sha256(secret)` plus the
 * first 8 characters so a human can tell two keys apart. Both are one-way: leaking
 * this table leaks no credential. The API key plaintext exists exactly once, in the
 * response to the request that created it.
 *
 * REVOCATION IS FAIL-OPEN FOR UNKNOWN SESSIONS
 * --------------------------------------------
 * `assertSessionLive` allows a token with no matching row. Every operator JWT
 * issued before this file existed has no row, and failing closed would sign out
 * every admin the moment it deploys — including whoever would have to log in to fix
 * it. A revoked row is refused; an absent one is not a decision, so it is not
 * treated as one.
 */
import crypto from 'crypto';
import type { Request } from 'express';
import prisma from './prisma.js';
import { clientIp } from './audit.js';
import type { AuthenticatedRequest } from './authMiddleware.js';
import { PERMISSIONS, type Permission } from './adminPermissions.js';

/** SHA-256 hex of a credential. The only form either table stores. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function userAgentOf(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return ua ? ua.toString().slice(0, 400) : null;
}

/**
 * Coarse device label from a user agent — "Chrome on Windows".
 *
 * Deliberately crude. The list a session page has to be useful is "this laptop and
 * that phone", which needs a browser and an OS and nothing else; parsing versions
 * would add a dependency and a maintenance burden for a string nobody acts on.
 */
export function deviceLabel(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser =
    /\bEdg\//.test(ua) ? 'Edge'
    : /\bOPR\//.test(ua) ? 'Opera'
    : /\bChrome\//.test(ua) ? 'Chrome'
    : /\bFirefox\//.test(ua) ? 'Firefox'
    : /\bSafari\//.test(ua) ? 'Safari'
    : /\bcurl\//i.test(ua) ? 'curl'
    : /\b(node|axios|python-requests|Go-http-client)\b/i.test(ua) ? 'Script'
    : null;
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /(iPhone|iPad|iOS)/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? null;
}

// ---------------------------------------------------------------------------
//  SIGN-IN ATTEMPTS (§29)
// ---------------------------------------------------------------------------

/** The outcomes `/api/auth/login` can reach. `ok` is the only success. */
export type LoginOutcome =
  | 'ok'
  | 'bad_password'
  | 'unknown_user'
  | 'suspended'
  | 'pending'
  | 'locked';

/**
 * Record one sign-in attempt. Never throws and never awaits anything the caller
 * needs: a security log that can fail a login is a denial-of-service switch.
 *
 * The email is stored as typed (lowercased) even when no such account exists —
 * "someone is trying `admin@`" is exactly the row an operator wants to see.
 */
export async function recordLoginAttempt(
  req: Request,
  email: string,
  outcome: LoginOutcome,
): Promise<void> {
  try {
    await prisma.loginAttempt.create({
      data: {
        email: email.slice(0, 200).toLowerCase(),
        ip: clientIp(req as AuthenticatedRequest),
        user_agent: userAgentOf(req),
        success: outcome === 'ok',
        outcome,
      },
    });
  } catch (err) {
    console.warn('[security] failed to record login attempt:', err);
  }
}

// ---------------------------------------------------------------------------
//  SESSIONS (§30)
// ---------------------------------------------------------------------------

/**
 * Store a session for a freshly issued operator token.
 *
 * `suspicious` is computed here rather than by a background job: at this instant we
 * know both the new IP/device and every previous one, and the flag is only useful
 * on the row it describes. "Never seen before for this account" is a deliberately
 * simple rule — no geo-IP, no scoring — because the operator reading the page is
 * the detector, and a flag they can explain is one they will act on.
 */
export async function recordSession(
  req: Request,
  params: { userId: string; token: string; expiresAt: Date },
): Promise<string | null> {
  try {
    const ip = clientIp(req as AuthenticatedRequest);
    const ua = userAgentOf(req);
    const device = deviceLabel(ua);

    const seen = await prisma.adminSession.findFirst({
      where: {
        user_id: params.userId,
        OR: [ip ? { ip } : { ip: null }, device ? { device } : { device: null }],
      },
      select: { id: true },
    });
    // First session on the account is not suspicious — there is nothing to differ
    // from. Only a *change* of address or device is worth flagging.
    const anyPrior = seen
      ? true
      : (await prisma.adminSession.count({ where: { user_id: params.userId } })) > 0;

    const row = await prisma.adminSession.create({
      data: {
        user_id: params.userId,
        token_hash: hashToken(params.token),
        ip,
        user_agent: ua,
        device,
        suspicious: anyPrior && !seen,
        expires_at: params.expiresAt,
      },
      select: { id: true, suspicious: true },
    });
    return row.id;
  } catch (err) {
    console.warn('[security] failed to record session:', err);
    return null;
  }
}

/** In-process throttle for `last_seen_at`: hash → epoch ms of the last write. */
const touched = new Map<string, number>();
const TOUCH_EVERY_MS = 5 * 60 * 1000;
/** Bound the map so a long-lived process cannot grow it without limit. */
const TOUCH_CAP = 2000;

/**
 * Refresh `last_seen_at`, at most once every five minutes per session.
 *
 * Without the throttle this would be a write on every admin request, which is a
 * silly amount of I/O for a column whose only consumer is a relative timestamp in a
 * list. Five minutes is finer than any decision made from that column.
 */
export function touchSession(token: string): void {
  const hash = hashToken(token);
  const now = Date.now();
  const last = touched.get(hash) ?? 0;
  if (now - last < TOUCH_EVERY_MS) return;
  if (touched.size > TOUCH_CAP) touched.clear();
  touched.set(hash, now);
  prisma.adminSession
    .updateMany({ where: { token_hash: hash, revoked_at: null }, data: { last_seen_at: new Date() } })
    .catch(() => undefined);
}

/**
 * Refuse a revoked session. Returns an error message, or null to allow.
 *
 * See the file header for why an unknown token is allowed. An *expired* row is also
 * allowed through: the JWT's own `exp` is the authority on expiry and has already
 * been checked by the caller, so a row whose `expires_at` drifted must not become a
 * second, disagreeing clock.
 */
export async function assertSessionLive(token: string): Promise<string | null> {
  try {
    const row = await prisma.adminSession.findUnique({
      where: { token_hash: hashToken(token) },
      select: { revoked_at: true, revoked_by: true },
    });
    if (!row || !row.revoked_at) return null;
    return row.revoked_by === 'self'
      ? 'This session was signed out. Please log in again.'
      : 'This session was revoked by an administrator. Please log in again.';
  } catch (err) {
    // Fail open on infrastructure trouble, consistent with the unknown-token case:
    // a DB hiccup must not sign every operator out.
    console.warn('[security] session check failed:', err);
    return null;
  }
}

/** Mark one session revoked. `by` is `self`, an admin id, or `password_change`. */
export async function revokeSession(id: string, by: string): Promise<boolean> {
  const result = await prisma.adminSession.updateMany({
    where: { id, revoked_at: null },
    data: { revoked_at: new Date(), revoked_by: by },
  });
  return result.count > 0;
}

/**
 * Revoke every live session for a user, optionally sparing the caller's own.
 *
 * Used by "sign out my other devices", by an operator killing someone else's
 * access, and by a password change — which already invalidates the JWTs via
 * `pwdv`, but leaving the rows looking live would make the sessions page lie.
 */
export async function revokeSessionsForUser(
  userId: string,
  by: string,
  exceptToken?: string,
): Promise<number> {
  const result = await prisma.adminSession.updateMany({
    where: {
      user_id: userId,
      revoked_at: null,
      ...(exceptToken ? { token_hash: { not: hashToken(exceptToken) } } : {}),
    },
    data: { revoked_at: new Date(), revoked_by: by },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  MACHINE API KEYS (§31)
// ---------------------------------------------------------------------------

/** Visible prefix so a key is identifiable in a list without being usable. */
const KEY_PREFIX = 'dk_';
const KEY_HEADER = 'x-admin-api-key';

/** Header name a client sends the key in. Exported for the docs shown in the UI. */
export const API_KEY_HEADER = KEY_HEADER;

/**
 * Mint a key. Returns the plaintext once — it is not recoverable afterwards,
 * because only its hash is stored.
 *
 * Permissions are validated against `PERMISSIONS` rather than stored as typed:
 * a key naming a permission that does not exist would silently hold nothing, and
 * the operator would find out from a 403 in a script at 3am.
 */
export async function createApiKey(params: {
  name: string;
  permissions: string[];
  expiresAt?: Date | null;
  createdBy?: string | null;
}): Promise<{ id: string; secret: string; prefix: string }> {
  const secret = `${KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
  const prefix = secret.slice(0, 11);
  const row = await prisma.adminApiKey.create({
    data: {
      name: params.name.slice(0, 120),
      key_hash: hashToken(secret),
      key_prefix: prefix,
      permissions: sanitizePermissions(params.permissions),
      created_by: params.createdBy ?? null,
      expires_at: params.expiresAt ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, secret, prefix };
}

/** Keep only permissions that exist, so a key's grant is never imaginary. */
export function sanitizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<string>(PERMISSIONS);
  const out: Permission[] = [];
  for (const value of input) {
    if (typeof value === 'string' && known.has(value) && !out.includes(value as Permission)) {
      out.push(value as Permission);
    }
  }
  return out;
}

/** Parse the JSON column back into a permission list, tolerating old/garbled rows. */
export function keyPermissions(value: unknown): Permission[] {
  if (typeof value === 'string') {
    try {
      return sanitizePermissions(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return sanitizePermissions(value);
}

export interface ApiKeyIdentity {
  id: string;
  name: string;
  permissions: Permission[];
}

/**
 * Authenticate the `x-admin-api-key` header, or return null when there is none.
 *
 * A revoked or expired key is a null, not an error: the caller then falls through
 * to normal JWT auth and gets the ordinary 401, which is the same answer with less
 * information disclosed about why.
 */
export async function authenticateApiKey(req: Request): Promise<ApiKeyIdentity | null> {
  const raw = req.headers[KEY_HEADER];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided || typeof provided !== 'string') return null;
  const token = provided.trim();
  if (!token.startsWith(KEY_PREFIX)) return null;
  try {
    const row = await prisma.adminApiKey.findUnique({
      where: { key_hash: hashToken(token) },
      select: { id: true, name: true, permissions: true, revoked_at: true, expires_at: true },
    });
    if (!row || row.revoked_at) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;
    // Best-effort usage stamp. The list page's "last used" column is the only way
    // to tell a live integration from a forgotten credential worth deleting.
    prisma.adminApiKey
      .update({ where: { id: row.id }, data: { last_used_at: new Date() } })
      .catch(() => undefined);
    return { id: row.id, name: row.name, permissions: keyPermissions(row.permissions) };
  } catch (err) {
    console.warn('[security] api key check failed:', err);
    return null;
  }
}
