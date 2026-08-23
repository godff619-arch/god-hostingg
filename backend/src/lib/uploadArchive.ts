// Admin-visible archive of user ZIP uploads.
// When a user creates a project from a ZIP, we keep a copy here so an operator
// can inspect exactly what was uploaded. Filesystem-backed (no schema change):
// each upload is `{id}.zip` plus a `{id}.json` sidecar with metadata.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

export interface UploadMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  userId: string | null;
  userEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  uploadedAt: string;
}

function archiveDir(): string {
  const dir = path.join(config.dataPath, 'admin-uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Reject anything that isn't a plain hex id we generated — blocks path traversal.
function isSafeId(id: string): boolean {
  return /^[a-f0-9]{16,64}$/.test(id);
}

/**
 * Copy an uploaded ZIP into the admin archive. Best-effort: never throws into
 * the request path — a failed archive must not break the user's deployment.
 */
export async function archiveUpload(
  srcPath: string,
  meta: Omit<UploadMeta, 'id' | 'uploadedAt' | 'sizeBytes'> & { sizeBytes?: number },
): Promise<string | null> {
  try {
    const id = crypto.randomBytes(16).toString('hex');
    const dir = archiveDir();
    const zipDest = path.join(dir, `${id}.zip`);
    await fs.promises.copyFile(srcPath, zipDest);
    const sizeBytes =
      meta.sizeBytes ?? (await fs.promises.stat(zipDest).then((s) => s.size).catch(() => 0));
    const record: UploadMeta = {
      id,
      originalName: meta.originalName,
      sizeBytes,
      userId: meta.userId,
      userEmail: meta.userEmail,
      projectId: meta.projectId,
      projectName: meta.projectName,
      uploadedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(record, null, 2),
      'utf-8',
    );
    return id;
  } catch (err) {
    console.warn('[uploadArchive] failed to archive upload (non-fatal):', err);
    return null;
  }
}

/** List archived uploads, newest first. */
export async function listArchivedUploads(): Promise<UploadMeta[]> {
  const dir = archiveDir();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const metas: UploadMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, f), 'utf-8');
      metas.push(JSON.parse(raw) as UploadMeta);
    } catch {
      // skip corrupt sidecar
    }
  }
  metas.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return metas;
}

/** Resolve the on-disk ZIP path for a given archive id, or null if missing/unsafe. */
export function archivedZipPath(id: string): string | null {
  if (!isSafeId(id)) return null;
  const p = path.join(archiveDir(), `${id}.zip`);
  return fs.existsSync(p) ? p : null;
}

/** Delete an archived upload (zip + sidecar). Returns true if anything was removed. */
export async function deleteArchivedUpload(id: string): Promise<boolean> {
  if (!isSafeId(id)) return false;
  const dir = archiveDir();
  let removed = false;
  for (const ext of ['zip', 'json']) {
    const p = path.join(dir, `${id}.${ext}`);
    try {
      await fs.promises.unlink(p);
      removed = true;
    } catch {
      // already gone
    }
  }
  return removed;
}
