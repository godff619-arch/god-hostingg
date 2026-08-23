/**
 * Error Center — grouped platform errors (spec Part D).
 *
 * The point of this file is that an operator can answer "what is broken right
 * now?" without reading a log file. Two design decisions carry that:
 *
 * 1. **Grouping.** A route that throws the same way 400 times is one row with
 *    `count = 400`, not 400 rows. The group key is a hash of source + route +
 *    the *normalized* message, where normalization strips the parts that vary
 *    between otherwise-identical failures (ids, ports, paths, timestamps). Two
 *    "project abc123 not found" / "project def456 not found" errors are the same
 *    bug and land in the same group.
 *
 * 2. **Recording never fails the request.** Every function here swallows its own
 *    errors, exactly like `writeAudit`. A broken error recorder that turns a 400
 *    into a 500 would be worse than no error recorder.
 *
 * Resolving a group is an operator note, not a fix — so a resolved group that
 * happens again is re-opened automatically. A silenced error can never hide a
 * live one.
 */
import crypto from 'crypto';
import type { Request } from 'express';
import prisma from './prisma.js';
import { getRequestId } from './requestId.js';
import type { AuthenticatedRequest } from './authMiddleware.js';

/** Where the failure came from. Free-form is allowed; these are the known ones. */
export const ERROR_SOURCES = [
  'api',
  'deploy',
  'docker',
  'git',
  'nginx',
  'cert',
  'webhook',
  'backup',
  'internal',
] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number] | string;

/** Stored detail is capped — a stack trace must not become an unbounded column. */
const MAX_DETAIL = 8_000;
const MAX_MESSAGE = 500;

export interface RecordErrorInput {
  source: ErrorSource;
  message: string;
  detail?: string | null;
  route?: string | null;
  statusCode?: number | null;
  requestId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  resource?: string | null;
  level?: 'error' | 'warn';
}

/**
 * Collapse the variable parts of a message so equivalent failures hash alike.
 * Order matters: the longest/most specific patterns run first, so a UUID is not
 * first mangled into digit placeholders by the numeric rule.
 */
export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    // uuid
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    // git sha / hex blob (7+ hex chars)
    .replace(/\b[0-9a-f]{7,64}\b/g, '<hex>')
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '<time>')
    // windows + posix absolute paths
    .replace(/[a-z]:\\[^\s'"]+/g, '<path>')
    .replace(/\/(?:[\w.-]+\/){2,}[\w.-]*/g, '<path>')
    // quoted literals (ids, names) — the quotes stay so structure survives
    .replace(/"[^"]{1,120}"/g, '"<v>"')
    .replace(/'[^']{1,120}'/g, "'<v>'")
    // bare numbers (ports, counts, byte sizes)
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** Stable group key. Same shape of failure on the same route → same fingerprint. */
export function fingerprintFor(source: string, route: string | null | undefined, message: string): string {
  const basis = `${source}|${route ?? '-'}|${normalizeMessage(message)}`;
  return crypto.createHash('sha1').update(basis).digest('hex');
}

function clamp(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * Record one occurrence. Creates the group on first sight, otherwise bumps
 * `count` / `last_seen_at` and refreshes the "latest occurrence" fields so the
 * row always shows the most recent request id and stack rather than the oldest.
 *
 * Never throws.
 */
export async function recordError(input: RecordErrorInput): Promise<void> {
  try {
    const message = clamp(input.message, MAX_MESSAGE) ?? 'Unknown error';
    const fingerprint = fingerprintFor(input.source, input.route, message);
    const latest = {
      message,
      detail: clamp(input.detail, MAX_DETAIL),
      route: input.route ?? null,
      status_code: input.statusCode ?? null,
      request_id: input.requestId ?? null,
      workspace_id: input.workspaceId ?? null,
      resource: input.resource ?? null,
      level: input.level ?? 'error',
    };
    // A user_id that no longer exists would break the FK; the group is still
    // worth keeping, so attribution is dropped rather than the whole record.
    const userId =
      input.userId && input.userId !== 'internal' ? input.userId : null;

    await prisma.errorEvent.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        source: input.source,
        user_id: userId,
        ...latest,
      },
      update: {
        ...latest,
        count: { increment: 1 },
        last_seen_at: new Date(),
        // Recurrence re-opens a resolved group — see file header.
        resolved_at: null,
        resolved_by: null,
      },
    });
  } catch (err) {
    // Retry once without the actor, which is the only FK that can fail here.
    if (input.userId) {
      try {
        await recordError({ ...input, userId: null });
        return;
      } catch {
        /* fall through to the warning */
      }
    }
    console.warn('[errorCenter] failed to record error:', err);
  }
}

/** Convenience wrapper for a failure raised inside an Express handler. */
export async function recordRequestError(
  req: Request,
  source: ErrorSource,
  err: unknown,
  statusCode?: number,
): Promise<void> {
  const error = err as Error & { message?: string; stack?: string };
  await recordError({
    source,
    message: error?.message || String(err),
    detail: error?.stack || null,
    route: `${req.method} ${req.route?.path ?? req.path}`,
    statusCode: statusCode ?? null,
    requestId: getRequestId(req) ?? null,
    userId: (req as AuthenticatedRequest).user?.userId ?? null,
  });
}

/**
 * Retention. Deletes resolved groups older than `resolvedAfterDays` and any
 * group untouched for `maxAgeDays`, so the table stays a *current* picture of
 * platform health instead of an append-only archive.
 *
 * Returns the number of rows removed. Never throws.
 */
export async function pruneErrorEvents(
  maxAgeDays = 30,
  resolvedAfterDays = 7,
): Promise<number> {
  try {
    const now = Date.now();
    const stale = new Date(now - maxAgeDays * 86_400_000);
    const resolvedCutoff = new Date(now - resolvedAfterDays * 86_400_000);
    const removed = await prisma.errorEvent.deleteMany({
      where: {
        OR: [
          { last_seen_at: { lt: stale } },
          { resolved_at: { not: null, lt: resolvedCutoff } },
        ],
      },
    });
    return removed.count;
  } catch (err) {
    console.warn('[errorCenter] prune failed:', err);
    return 0;
  }
}
