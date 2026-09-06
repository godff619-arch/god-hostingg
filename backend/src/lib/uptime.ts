// Platform uptime — how long we have been up, and when we were not.
//
// The status page needs to tell a tenant two things: is the platform up right
// now, and how much has it been down. Neither can be answered from a process
// counter alone — `process.uptime()` is reset by the very restart the visitor is
// asking about, and nothing in the panel recorded that it had stopped.
//
// So each boot writes a session row and refreshes a heartbeat while it runs. The
// next boot closes the previous row and measures the distance from its last
// heartbeat: that distance *is* the downtime, observed rather than estimated. A
// clean SIGTERM marks the row `clean_exit`, which is what separates "we
// redeployed" from "the host fell over" on the incident list.
//
// Deliberately not a percentage pulled out of the air (§53). Availability is
// reported against the window we actually have data for, and the API says how
// long that window is so the UI can show "since 2 Sep" instead of implying a
// year of history on a database that is three days old.

import os from 'os';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import prisma from './prisma.js';

/** Heartbeat cadence. Also the resolution of any downtime we can detect. */
const HEARTBEAT_MS = 30_000;

/**
 * A gap under this reads as a restart (a deploy, an update, a `docker compose
 * up`), not an outage. Both are recorded; only the label differs.
 */
const OUTAGE_THRESHOLD_SECONDS = 120;

/** Gaps shorter than this are clock jitter between two heartbeats, not events. */
const MIN_RECORDED_GAP_SECONDS = 5;

/** Availability window. */
const WINDOW_DAYS = 30;

/** How many sessions to consider — bounds the query on a long-lived install. */
const MAX_SESSIONS = 200;

export interface UptimeIncident {
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  /** `outage` past OUTAGE_THRESHOLD_SECONDS, `restart` below it. */
  kind: 'outage' | 'restart';
  /** True when the previous session shut down on a signal rather than dying. */
  planned: boolean;
}

export interface UptimeStatus {
  status: 'operational' | 'recovering';
  /** When the process now serving you started. */
  started_at: string | null;
  uptime_seconds: number;
  /** The machine's own uptime, which outlives a panel restart. */
  host_uptime_seconds: number;
  window_days: number;
  /** Start of the period these figures cover — never earlier than the first record. */
  observed_from: string | null;
  observed_seconds: number;
  downtime_seconds: number;
  /** Null until there is enough history to divide by. */
  uptime_percent: number | null;
  restarts: number;
  last_incident: UptimeIncident | null;
  incidents: UptimeIncident[];
  checked_at: string;
}

let sessionId: string | null = null;
let heartbeat: NodeJS.Timeout | null = null;

/** Stamps the session with the build that ran it, so an incident has a version. */
function panelVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Opens this boot's session: closes whatever the last one left behind, measures
 * the gap, and starts the heartbeat.
 *
 * Never throws. Uptime reporting is a nicety; a missing table on a database that
 * has not run `ensureDb` yet must not stop the platform from serving traffic.
 */
export async function startUptimeTracking(version: string | null = panelVersion()): Promise<void> {
  try {
    const previous = await prisma.platformUptime.findFirst({
      orderBy: { started_at: 'desc' },
    });

    let gapSeconds = 0;
    if (previous) {
      // A clean shutdown told us exactly when it stopped. A crash did not, so the
      // last heartbeat is the most recent moment we know it was still answering.
      const lastKnownUp = previous.ended_at ?? previous.last_seen_at;
      gapSeconds = Math.max(0, Math.round((Date.now() - lastKnownUp.getTime()) / 1000));

      if (!previous.ended_at) {
        await prisma.platformUptime.update({
          where: { id: previous.id },
          data: { ended_at: previous.last_seen_at, clean_exit: false },
        });
      }
    }

    const row = await prisma.platformUptime.create({
      data: { gap_seconds: gapSeconds, version: version ?? null },
    });
    sessionId = row.id;

    if (gapSeconds >= OUTAGE_THRESHOLD_SECONDS) {
      console.warn(`⏱️  Platform was down for ${formatDuration(gapSeconds)} before this start`);
    }

    heartbeat = setInterval(() => void touch(), HEARTBEAT_MS);
    // Must not keep the event loop alive on its own — shutdown clears it anyway,
    // but an unref'd timer means a stuck drain still lets the process exit.
    heartbeat.unref();
  } catch (err) {
    console.warn('[uptime] tracking unavailable:', (err as Error)?.message ?? err);
  }
}

async function touch(): Promise<void> {
  if (!sessionId) return;
  try {
    await prisma.platformUptime.update({
      where: { id: sessionId },
      data: { last_seen_at: new Date() },
    });
  } catch {
    // A single missed heartbeat costs at most HEARTBEAT_MS of resolution.
  }
}

/** Called from the graceful-shutdown path, so a planned restart is labelled as one. */
export async function stopUptimeTracking(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (!sessionId) return;
  try {
    await prisma.platformUptime.update({
      where: { id: sessionId },
      data: { ended_at: new Date(), last_seen_at: new Date(), clean_exit: true },
    });
  } catch {
    // Nothing to do: the next boot will close the row from its last heartbeat.
  }
  sessionId = null;
}

/** `1d 2h`, `4m 12s` — for the boot warning; the UI formats its own copy. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

/**
 * The status payload. Safe for any signed-in user: uptime, downtime and when the
 * platform restarted — no hostname, no kernel, no CPU or memory figures. Those
 * stay on the admin-only `/api/system/stats`.
 */
export async function uptimeStatus(): Promise<UptimeStatus> {
  const now = Date.now();
  const windowStart = now - WINDOW_DAYS * 86_400_000;

  const rows = await prisma.platformUptime.findMany({
    orderBy: { started_at: 'desc' },
    take: MAX_SESSIONS,
  });
  const ordered = [...rows].reverse(); // oldest → newest
  const current = rows[0] ?? null;

  // Availability can only be claimed for the period there are rows for. On a
  // fresh install that is minutes, and the response says so rather than
  // implying a month of perfect history.
  const firstStart = ordered[0]?.started_at.getTime() ?? now;
  const observedFrom = Math.max(windowStart, firstStart);

  const incidents: UptimeIncident[] = [];
  let downtime = 0;

  ordered.forEach((row, index) => {
    const gap = row.gap_seconds;
    if (gap < MIN_RECORDED_GAP_SECONDS) return;
    const endedAt = row.started_at.getTime();
    const startedAt = endedAt - gap * 1000;
    // Clip to the window. An outage that began before it counts only for the part
    // inside, or the percentage would charge us twice for the same minutes.
    const overlap = Math.max(0, Math.min(endedAt, now) - Math.max(startedAt, observedFrom));
    if (overlap <= 0) return;
    downtime += Math.round(overlap / 1000);
    incidents.push({
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_seconds: gap,
      kind: gap >= OUTAGE_THRESHOLD_SECONDS ? 'outage' : 'restart',
      // The gap before this session was caused by the end of the one before it.
      planned: ordered[index - 1]?.clean_exit ?? false,
    });
  });

  const observedSeconds = Math.max(0, Math.round((now - observedFrom) / 1000));
  const percent =
    observedSeconds > 0
      ? Math.max(0, Math.min(100, ((observedSeconds - downtime) / observedSeconds) * 100))
      : null;

  const startedAt = current?.started_at ?? null;
  // "Recovering" is a fact, not a mood: the process answering you came back from
  // a real outage less than five minutes ago.
  const justRecovered =
    !!current &&
    current.gap_seconds >= OUTAGE_THRESHOLD_SECONDS &&
    now - current.started_at.getTime() < 5 * 60_000;

  return {
    status: justRecovered ? 'recovering' : 'operational',
    started_at: startedAt ? startedAt.toISOString() : null,
    uptime_seconds: startedAt
      ? Math.max(0, Math.round((now - startedAt.getTime()) / 1000))
      : Math.round(process.uptime()),
    host_uptime_seconds: Math.round(os.uptime()),
    window_days: WINDOW_DAYS,
    observed_from: new Date(observedFrom).toISOString(),
    observed_seconds: observedSeconds,
    downtime_seconds: downtime,
    uptime_percent: percent === null ? null : Number(percent.toFixed(4)),
    restarts: incidents.length,
    last_incident: incidents.length ? incidents[incidents.length - 1] : null,
    incidents: incidents.slice(-25).reverse(), // newest first
    checked_at: new Date(now).toISOString(),
  };
}
