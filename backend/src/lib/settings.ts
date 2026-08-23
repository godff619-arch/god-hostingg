/**
 * DB-backed key/value settings on the existing `Settings` model.
 * Central helpers for admin-configurable platform settings (github.ts keeps its
 * own local copy for now; new admin settings use this module).
 *
 * All values are stored as strings. Typed helpers coerce on read/write.
 */
import prisma from './prisma.js';

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.settings.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.settings.upsert({
    where: { key },
    update: { value, updated_at: new Date() },
    create: { key, value, updated_at: new Date() },
  });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await prisma.settings.findMany();
  const out: Record<string, string> = {};
  for (const r of rows) if (r.value != null) out[r.key] = r.value;
  return out;
}

/** Read a boolean setting; returns `fallback` when unset or unparseable. */
export async function getBoolSetting(key: string, fallback: boolean): Promise<boolean> {
  const v = await getSetting(key);
  if (v == null) return fallback;
  return v === 'true' || v === '1';
}

export async function setBoolSetting(key: string, value: boolean): Promise<void> {
  await setSetting(key, value ? 'true' : 'false');
}

/** Read a JSON setting; returns `fallback` on missing/invalid JSON. */
export async function getJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const v = await getSetting(key);
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}
