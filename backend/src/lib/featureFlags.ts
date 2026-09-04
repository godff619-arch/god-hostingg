/**
 * Platform feature flags — capability switches an operator can turn off.
 *
 * A flag here is not documentation: every key in `FEATURE_FLAGS` is enforced by
 * real server-side code (see `enforcedAt` on each entry, and the `requireFeature`
 * mounts in index.ts). A flag with nothing behind it does not belong in this list.
 *
 * Semantics, chosen deliberately and relied on by the admin page:
 *
 *  • A disabled flag disables the capability for EVERYONE, admins included. These
 *    are "does this platform offer X", not permissions — an admin exemption would
 *    hide from the operator exactly what their users are about to hit.
 *  • Disabling never hides or deletes what already exists. Gates sit on mutations
 *    (POST/PUT/PATCH/DELETE); GETs stay open, so a user whose databases were
 *    turned off can still see and connect to the ones they have.
 *  • Recovery paths are never gated. Backup *restore* stays reachable with
 *    `backups` off, because the flag lives in the database being restored and an
 *    operator locked out of restore by a row inside the broken DB has no way back.
 *
 * Reads are cached for a few seconds: the gate runs on every mutating request and
 * the value changes about once a month, so a per-request SELECT would be pure
 * overhead. `invalidateFeatureFlagCache()` is called on write, so the admin page
 * sees its own change immediately and other instances converge within the TTL.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getJsonSetting, setJsonSetting } from './settings.js';

export const S_FEATURE_FLAGS = 'feature_flags';

export interface FeatureFlagDef {
  key: string;
  label: string;
  /** What the user can still do, and what stops, when this is off. */
  description: string;
  /** Sidebar-style grouping for the admin page. */
  group: 'Deploy sources' | 'Services' | 'Networking' | 'Operations';
  /** Value when the operator has never touched it. Everything ships on. */
  default: boolean;
  /** Human-readable enforcement point, surfaced in the UI so it is auditable. */
  enforcedAt: string;
}

export const FEATURE_FLAGS: FeatureFlagDef[] = [
  {
    key: 'git_deploy',
    label: 'Deploy from Git',
    description:
      'Creating services from a GitHub repository. Existing Git services keep deploying.',
    group: 'Deploy sources',
    default: true,
    enforcedAt: 'POST /api/projects (github source)',
  },
  {
    key: 'zip_upload',
    label: 'Deploy from ZIP upload',
    description: 'Creating services by uploading an archive. Existing ones are untouched.',
    group: 'Deploy sources',
    default: true,
    enforcedAt: 'POST /api/projects (upload source)',
  },
  {
    key: 'blueprints',
    label: 'Blueprints',
    description: 'Creating, editing, syncing and applying infrastructure-as-code blueprints.',
    group: 'Deploy sources',
    default: true,
    enforcedAt: 'mutations on /api/blueprints',
  },
  {
    key: 'databases',
    label: 'Managed databases',
    description: 'Provisioning databases and linking them to services. Existing ones keep running.',
    group: 'Services',
    default: true,
    enforcedAt: 'mutations on /api/databases',
  },
  {
    key: 'env_groups',
    label: 'Environment groups',
    description: 'Creating and editing shared variable groups. Linked groups still apply.',
    group: 'Services',
    default: true,
    enforcedAt: 'mutations on /api/env-groups',
  },
  {
    key: 'file_manager',
    label: 'File editing',
    description: 'Saving edits to files in a service. Browsing and reading stay available.',
    group: 'Services',
    default: true,
    enforcedAt: 'PUT /api/files/:projectId/content',
  },
  {
    key: 'custom_domains',
    label: 'Custom domains',
    description:
      'Attaching your own hostnames and retrying certificates. Live domains keep serving.',
    group: 'Networking',
    default: true,
    enforcedAt: 'mutations on /api/domains',
  },
  {
    key: 'private_links',
    label: 'Private links',
    description: 'Creating and applying service-to-service private links.',
    group: 'Networking',
    default: true,
    enforcedAt: 'mutations on /api/private-links',
  },
  {
    key: 'backups',
    label: 'Backup creation',
    description:
      'Taking new platform backups. Restore is never gated, so a bad flag cannot lock you out.',
    group: 'Operations',
    default: true,
    enforcedAt: 'POST /api/backup/create',
  },
  {
    key: 'web_terminal',
    label: 'Web terminal',
    description: 'The in-browser server shell. Off refuses the WebSocket upgrade outright.',
    group: 'Operations',
    default: true,
    enforcedAt: 'WS /ws/terminal upgrade',
  },
];

const DEFAULTS: Record<string, boolean> = Object.fromEntries(
  FEATURE_FLAGS.map((f) => [f.key, f.default]),
);

/** Keys the platform actually enforces. Anything else is rejected on write. */
export const FEATURE_FLAG_KEYS: string[] = FEATURE_FLAGS.map((f) => f.key);

export function isFeatureFlagKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

/** How long a read is reused. Short enough that a toggle lands without a restart. */
const CACHE_TTL_MS = 5_000;

let cache: { flags: Record<string, boolean>; at: number } | null = null;

export function invalidateFeatureFlagCache(): void {
  cache = null;
}

/**
 * Every known flag with its effective value. Unknown keys left over in the stored
 * JSON (a removed flag, a hand-edited row) are dropped rather than surfaced, so
 * the admin page can never show a switch that controls nothing.
 */
export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.flags;
  let stored: Record<string, unknown> = {};
  try {
    stored = await getJsonSetting<Record<string, unknown>>(S_FEATURE_FLAGS, {});
  } catch (err) {
    // A settings read failure must not take the whole API down with it: fall back
    // to defaults (everything on) rather than refusing every gated mutation.
    console.warn('[flags] read failed, using defaults:', err);
    stored = {};
  }
  const flags: Record<string, boolean> = {};
  for (const def of FEATURE_FLAGS) {
    const raw = stored?.[def.key];
    flags[def.key] = typeof raw === 'boolean' ? raw : def.default;
  }
  cache = { flags, at: Date.now() };
  return flags;
}

export async function isFeatureEnabled(key: string): Promise<boolean> {
  if (!isFeatureFlagKey(key)) return true;
  return (await getFeatureFlags())[key];
}

/**
 * Apply a partial change. Only known keys are accepted, and only booleans, so a
 * typo in the request body can never write a switch nobody reads. Returns the
 * full effective set and the keys that actually changed (for the audit entry).
 */
export async function setFeatureFlags(
  patch: Record<string, unknown>,
): Promise<{ flags: Record<string, boolean>; changed: string[] }> {
  const current = await getFeatureFlags();
  const next: Record<string, boolean> = { ...current };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!isFeatureFlagKey(key)) throw new Error(`Unknown feature flag: ${key}`);
    if (typeof value !== 'boolean') throw new Error(`Feature flag "${key}" must be true or false`);
    if (next[key] !== value) changed.push(key);
    next[key] = value;
  }
  if (changed.length) {
    await setJsonSetting(S_FEATURE_FLAGS, next);
    invalidateFeatureFlagCache();
  }
  return { flags: next, changed };
}

/** The body every refusal sends, so the frontend can recognise one shape. */
export function featureDisabledBody(key: string): {
  error: string;
  feature: string;
  featureDisabled: true;
} {
  const def = FEATURE_FLAGS.find((f) => f.key === key);
  return {
    error: `${def?.label ?? key} is disabled on this platform. An administrator can re-enable it in Admin → Feature Flags.`,
    feature: key,
    featureDisabled: true,
  };
}

/**
 * 403 when the flag is off. 403 rather than 503: this is a standing policy the
 * operator chose, not an outage, so a client must not retry its way through it.
 */
export function requireFeature(key: string): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (await isFeatureEnabled(key)) return next();
    res.status(403).json(featureDisabledBody(key));
  };
}

/**
 * Gate writes only. Reading what already exists is never the thing an operator
 * means to switch off, and hiding it would look like data loss.
 */
export function requireFeatureForWrites(key: string): RequestHandler {
  const gate = requireFeature(key);
  return (req, res, next) =>
    req.method === 'GET' || req.method === 'HEAD' ? next() : gate(req, res, next);
}
