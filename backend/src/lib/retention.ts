/**
 * Log retention (spec Part D — operations center).
 *
 * Two log stores grow without bound otherwise: the audit trail (`AuditLog`) and
 * the grouped Error Center (`ErrorEvent`). Retention is operator-configurable via
 * the DB settings (see admin `/settings`), read fresh on every run so a change
 * takes effect at the next daily sweep without a restart.
 *
 * Retention is expressed in whole days. `0` means KEEP FOREVER — an explicit,
 * documented contract, never a magic sentinel: a 0 simply skips that store's
 * delete. Values are clamped to a sane ceiling (10 years) on write so a fat-
 * fingered entry can't turn the sweep into a table scan of the epoch.
 *
 * Everything here is best-effort: a failed prune logs and returns 0 rather than
 * throwing, so the daily timer (index.ts) can never crash the process.
 */
import prisma from './prisma.js';
import { getSetting } from './settings.js';
import { pruneErrorEvents } from './errorCenter.js';

export const S_AUDIT_RETENTION_DAYS = 'audit_retention_days';
export const S_ERROR_RETENTION_DAYS = 'error_retention_days';
export const S_ERROR_RESOLVED_RETENTION_DAYS = 'error_resolved_retention_days';

/** Defaults when the setting is unset. Audit trails are kept longer than noise. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_ERROR_RETENTION_DAYS = 30;
export const DEFAULT_ERROR_RESOLVED_RETENTION_DAYS = 7;

/** Max any retention may be set to (10 years). Guards against absurd inputs. */
export const MAX_RETENTION_DAYS = 3650;

/** Coerce arbitrary input to a whole day count in [0, MAX]. NaN/negative → null (leave unchanged). */
export function coerceRetentionDays(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_RETENTION_DAYS, Math.floor(n));
}

async function readDays(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(MAX_RETENTION_DAYS, Math.floor(n)) : fallback;
}

export interface RetentionConfig {
  auditDays: number;
  errorDays: number;
  errorResolvedDays: number;
}

export async function getRetentionConfig(): Promise<RetentionConfig> {
  const [auditDays, errorDays, errorResolvedDays] = await Promise.all([
    readDays(S_AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS),
    readDays(S_ERROR_RETENTION_DAYS, DEFAULT_ERROR_RETENTION_DAYS),
    readDays(S_ERROR_RESOLVED_RETENTION_DAYS, DEFAULT_ERROR_RESOLVED_RETENTION_DAYS),
  ]);
  return { auditDays, errorDays, errorResolvedDays };
}

/** Delete audit rows older than `maxAgeDays`. `0` = keep forever (no-op). */
export async function pruneAuditLogs(maxAgeDays: number): Promise<number> {
  if (!maxAgeDays || maxAgeDays <= 0) return 0;
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
    const removed = await prisma.auditLog.deleteMany({ where: { created_at: { lt: cutoff } } });
    return removed.count;
  } catch (err) {
    console.warn('[retention] audit prune failed:', err);
    return 0;
  }
}

/**
 * One full retention sweep across both log stores using the current settings.
 * Returns per-store deletion counts so the caller can log a single summary line.
 */
export async function runRetentionSweep(): Promise<{ audit: number; errors: number }> {
  const cfg = await getRetentionConfig();
  const audit = await pruneAuditLogs(cfg.auditDays);
  // errorDays === 0 → keep forever: skip the error prune entirely.
  const errors = cfg.errorDays > 0 ? await pruneErrorEvents(cfg.errorDays, cfg.errorResolvedDays) : 0;
  return { audit, errors };
}
