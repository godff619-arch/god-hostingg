/**
 * The two platform switches on Admin → Settings that gate live behaviour:
 * `deployments_enabled` and `maintenance_mode`.
 *
 * NOT the same thing as lib/maintenance.ts. That one is a process-local flag held
 * only while a restore is rewriting the SQLite file, and it blocks *everything*
 * including admins. This one is the operator's own maintenance window: it lives in
 * the database, survives a restart, and deliberately keeps the ops center working
 * so whoever flipped it can flip it back.
 *
 * Both are cached briefly for the same reason as the feature flags: the gate runs
 * on every request and the value changes rarely. Writers call
 * `invalidatePlatformSwitchCache()`, so an operator's own toggle takes effect at
 * once and any other instance converges inside the TTL.
 */
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getBoolSetting, getSetting } from './settings.js';
import { JWT_SECRET, type AuthenticatedRequest } from './authMiddleware.js';
import { hasAdminAccess } from './platformRoles.js';

export const S_DEPLOYMENTS_ENABLED = 'deployments_enabled';
export const S_MAINTENANCE_MODE = 'maintenance_mode';
export const S_MAINTENANCE_MESSAGE = 'maintenance_message';

export const DEFAULT_MAINTENANCE_MESSAGE =
  'The platform is temporarily unavailable for maintenance. Please try again shortly.';

const CACHE_TTL_MS = 5_000;

interface Switches {
  deploymentsEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

let cache: { value: Switches; at: number } | null = null;

export function invalidatePlatformSwitchCache(): void {
  cache = null;
}

export async function getPlatformSwitches(): Promise<Switches> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const [deploymentsEnabled, maintenanceMode, message] = await Promise.all([
      getBoolSetting(S_DEPLOYMENTS_ENABLED, true),
      getBoolSetting(S_MAINTENANCE_MODE, false),
      getSetting(S_MAINTENANCE_MESSAGE),
    ]);
    const value: Switches = {
      deploymentsEnabled,
      maintenanceMode,
      maintenanceMessage: message?.trim() || DEFAULT_MAINTENANCE_MESSAGE,
    };
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    // Fail open: a settings read failure must not look like a maintenance window
    // or stop every deploy on the platform.
    console.warn('[switches] read failed, assuming open:', err);
    return {
      deploymentsEnabled: true,
      maintenanceMode: false,
      maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
    };
  }
}

export async function areDeploymentsEnabled(): Promise<boolean> {
  return (await getPlatformSwitches()).deploymentsEnabled;
}

/**
 * Refuse a new deploy while `deployments_enabled` is off — including the GitHub
 * auto-deploy path, which reaches the same endpoint over loopback.
 *
 * Stop, restart and cancel are deliberately NOT gated: an operator who has paused
 * deploys still has to be able to bring a misbehaving container down.
 */
export async function assertDeploymentsEnabled(res: Response): Promise<boolean> {
  if (await areDeploymentsEnabled()) return true;
  res.status(403).json({
    error:
      'Deployments are currently disabled by an administrator. Running services are unaffected.',
    deploymentsDisabled: true,
  });
  return false;
}

/**
 * Paths that stay reachable during an operator maintenance window.
 *
 * `/api/auth` has to work or the admin who enabled maintenance cannot log back in
 * to disable it; `/api/admin` is the ops center itself (it enforces its own admin
 * check); `/api/health` is what an uptime probe and the container healthcheck hit;
 * `/api/backup/restore` is a recovery path and is never gated.
 */
function isMaintenanceExempt(path: string): boolean {
  return (
    path === '/api/health' ||
    path.startsWith('/api/auth') ||
    path.startsWith('/api/admin') ||
    path.startsWith('/api/backup/restore')
  );
}

/**
 * DB-backed maintenance gate. Sits after the rate limiter and before the
 * per-router auth middleware, so it must decide "is this an operator?" from the
 * bearer token alone — the token's `role` claim is enough for a *cosmetic*
 * allowance like this, and every exempt surface re-authenticates properly anyway.
 *
 * Normal users get a 503 carrying `maintenance: true` and the operator's message,
 * which the frontend turns into a full maintenance page.
 */
export async function platformMaintenanceGate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { maintenanceMode, maintenanceMessage } = await getPlatformSwitches();
  if (!maintenanceMode) return next();
  if (isMaintenanceExempt(req.path)) return next();
  // Internal loopback calls (the GitHub webhook trampoline) are tenant work and
  // stay blocked, so a push during a maintenance window does not deploy.
  if (hasAdminAccess(roleFromBearer(req))) return next();
  res.status(503).json({ error: maintenanceMessage, maintenance: true });
}

/**
 * Best-effort role from the Authorization header. Never throws and never trusts
 * the value for anything but the maintenance allowance above: an expired or
 * forged token simply reads as "not an operator" and gets the maintenance page.
 */
function roleFromBearer(req: AuthenticatedRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET) as { role?: string };
    return decoded?.role ?? null;
  } catch {
    return null;
  }
}
