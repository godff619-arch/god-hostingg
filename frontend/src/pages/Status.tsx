// Status page — availability stated as fact, for everyone on the platform.
//
// `/system` is the operator's view: CPU, memory, disks, kernel, load, process
// names. That is detail about the machine every tenant shares, so it is
// admin-only now — and refused by the API, not merely hidden in the rail
// (routes/system.ts, spec §47). What a tenant actually wants is narrower, and
// this page answers exactly that: is the platform up, how long has it been up,
// and when was it not.
//
// Every figure here comes from the `platform_uptime` session rows the backend
// writes itself — one per boot, kept alive by a heartbeat. Nothing is a
// decorative "99.9%": availability is reported against the window there is data
// for, and the page says how long that window is. On a database that is two days
// old, it says two days (spec §53).

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  CheckCircle2,
  Clock,
  Gauge,
  RefreshCw,
  RotateCw,
  Server,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/AuthProvider";
import { authFetch } from "@/lib/auth";
import { hasAdminAccess } from "@/lib/roles";
import { API_URL, cn } from "@/lib/utils";

interface UptimeIncident {
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  /** Past two minutes it is an outage; below that it reads as a restart. */
  kind: "outage" | "restart";
  /** The previous session exited on a signal, so this gap was intended. */
  planned: boolean;
}

interface PlatformStatus {
  status: "operational" | "recovering";
  started_at: string | null;
  uptime_seconds: number;
  host_uptime_seconds: number;
  window_days: number;
  observed_from: string | null;
  observed_seconds: number;
  downtime_seconds: number;
  /** Null until there is a measured window to divide by. */
  uptime_percent: number | null;
  restarts: number;
  last_incident: UptimeIncident | null;
  incidents: UptimeIncident[];
  checked_at: string;
}

/** Server figures are re-read on a slow loop; the clock below ticks locally. */
const REFRESH_MS = 60_000;

/** Two units is all anyone reads at a glance: `6d 4h`, `12m 30s`. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  const sec = s % 60;
  return sec ? `${m}m ${sec}s` : `${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `100%` and `99.95%`, never `100.0000%` — trailing zeros read as noise. */
function formatPercent(pct: number): string {
  const text = pct.toFixed(pct >= 99.99 && pct < 100 ? 3 : 2);
  if (!text.includes(".")) return `${text}%`;
  return `${text.replace(/0+$/, "").replace(/\.$/, "")}%`;
}

type Tone = "success" | "warning" | "danger" | "muted";

const toneBox: Record<Tone, string> = {
  success: "border-success-border bg-success-surface text-success",
  warning: "border-warning-border bg-warning-surface text-warning",
  danger: "border-danger-border bg-danger-surface text-danger",
  muted: "border-border/60 bg-secondary/40 text-muted-foreground",
};

const toneBadge: Record<Tone, string> = {
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
  muted: "bg-secondary/60 text-muted-foreground",
};

/** A clean shutdown was maintenance. A gap nobody announced was not. */
function describeIncident(incident: UptimeIncident): { label: string; tone: Tone } {
  if (incident.kind === "outage") {
    return incident.planned
      ? { label: "Planned maintenance", tone: "warning" }
      : { label: "Unplanned outage", tone: "danger" };
  }
  return incident.planned
    ? { label: "Planned restart", tone: "muted" }
    : { label: "Unexpected restart", tone: "warning" };
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-3.5 sm:p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

/** First paint: the same boxes, sized, so nothing jumps when data lands (§52). */
function StatusSkeleton() {
  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="h-10 w-48 animate-pulse rounded-xl bg-secondary/30" />
      <div className="h-[5.5rem] animate-pulse rounded-2xl bg-secondary/25" />
      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[6.5rem] animate-pulse rounded-2xl bg-secondary/20" />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
        <div className="h-11 animate-pulse border-b border-border/40 bg-secondary/25" />
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse border-b border-border/40 bg-secondary/15 last:border-b-0"
          />
        ))}
      </div>
    </div>
  );
}

function StatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-border/60 bg-card px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-danger-border bg-danger-surface">
        <TriangleAlert className="h-5 w-5 text-danger" />
      </span>
      <p className="mt-3 text-sm font-semibold">Status is unavailable</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{message}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="press mt-4 gap-1.5 border-border/60"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}

export default function StatusPage() {
  const { user } = useAuth();
  const isOperator = hasAdminAccess(user?.role);

  const [data, setData] = useState<PlatformStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Seconds since the payload was built, so the counters move between fetches. */
  const [drift, setDrift] = useState(0);
  const loadedAt = useRef(Date.now());

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/api/system/status`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `The server answered ${res.status}.`);
      }
      const payload = (await res.json()) as PlatformStatus;
      loadedAt.current = Date.now();
      setDrift(0);
      setData(payload);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not reach the server. It may be restarting.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Slow poll. A restart is exactly what this page reports, so it has to notice
  // one without the visitor reloading.
  useEffect(() => {
    const poll = window.setInterval(() => void load(true), REFRESH_MS);
    return () => window.clearInterval(poll);
  }, [load]);

  // A frozen "running for 4h 12m" looks like a stale page, so the second hand is
  // client-side and only the base figure comes from the server.
  useEffect(() => {
    if (!data) return;
    const tick = window.setInterval(() => {
      setDrift(Math.max(0, Math.round((Date.now() - loadedAt.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [data]);

  if (loading && !data) return <StatusSkeleton />;
  if (error && !data) return <StatusError message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const operational = data.status === "operational";
  const uptime = data.uptime_seconds + drift;
  const hostUptime = data.host_uptime_seconds + drift;
  const observed = data.observed_seconds + drift;
  const incidents = data.incidents;

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand/20 bg-brand/10 sm:h-10 sm:w-10 sm:rounded-2xl">
            <Activity className="h-4 w-4 text-brand sm:h-[1.125rem] sm:w-[1.125rem]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight sm:text-xl">Status</h1>
            <p className="truncate text-[11px] text-muted-foreground sm:text-xs">
              Uptime and downtime, measured on this server
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {isOperator && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="press hidden h-9 gap-1.5 border-border/60 sm:inline-flex sm:h-10"
            >
              <Link to="/system">
                <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
                Host metrics
              </Link>
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={() => void load(true)}
            disabled={refreshing}
            title="Refresh status"
            aria-label="Refresh status"
            className="press h-9 w-9 shrink-0 border-border/60 bg-background hover:bg-secondary/80 sm:h-10 sm:w-10"
          >
            <RefreshCw
              className={cn(
                "h-4 w-4 text-muted-foreground",
                refreshing && "animate-spin",
              )}
            />
          </Button>
        </div>
      </div>

      {/* A refresh that failed must not silently replace live figures with old ones. */}
      {error && (
        <div className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-[11px] text-warning sm:text-xs">
          Showing the last known figures — the latest refresh failed. {error}
        </div>
      )}

      <section
        className={cn(
          "rounded-2xl border p-4 sm:p-5",
          operational
            ? "border-success-border bg-success-surface"
            : "border-warning-border bg-warning-surface",
        )}
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border bg-background",
                operational
                  ? "border-success-border text-success"
                  : "border-warning-border text-warning",
              )}
            >
              {operational ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <TriangleAlert className="h-5 w-5" />
              )}
            </span>

            <div className="min-w-0">
              <p
                className={cn(
                  "text-base font-bold tracking-tight sm:text-lg",
                  operational ? "text-success" : "text-warning",
                )}
              >
                {operational ? "All systems operational" : "Recovering from an outage"}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/70 sm:text-xs">
                Running for{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {formatDuration(uptime)}
                </span>
                {data.started_at && ` · up since ${formatDateTime(data.started_at)}`}
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/70 px-2 py-1 text-[10px] font-medium text-muted-foreground tabular-nums">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                operational ? "animate-pulse bg-success" : "animate-pulse bg-warning",
              )}
            />
            Checked {formatClock(data.checked_at)}
          </span>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard
          icon={Activity}
          label="Availability"
          value={data.uptime_percent === null ? "—" : formatPercent(data.uptime_percent)}
          hint={
            data.uptime_percent === null
              ? "Collecting data — a figure appears once there is a measured window."
              : data.observed_from
                ? `Since ${formatDate(data.observed_from)} · ${formatDuration(observed)} of measured history`
                : `Over the last ${data.window_days} days`
          }
        />
        <StatCard
          icon={Clock}
          label="Total downtime"
          value={data.downtime_seconds > 0 ? formatDuration(data.downtime_seconds) : "None"}
          hint={
            data.restarts === 0
              ? `No interruption recorded in the last ${data.window_days} days.`
              : `Across ${data.restarts} ${data.restarts === 1 ? "event" : "events"} in the last ${data.window_days} days.`
          }
        />

        <StatCard
          icon={Server}
          label="Host uptime"
          value={formatDuration(hostUptime)}
          hint="The machine behind this panel — it outlives a panel restart."
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/60 bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-secondary/25 px-3.5 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Downtime history
            </h2>
            {incidents.length > 0 && (
              <span className="rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-foreground/70">
                {incidents.length}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {data.observed_from
              ? `Measured since ${formatDate(data.observed_from)}`
              : `Last ${data.window_days} days`}
          </p>
        </header>

        {incidents.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
            <CheckCircle2 className="mb-3 h-8 w-8 text-success/50" />
            <p className="text-sm font-semibold">No downtime recorded</p>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
              {data.observed_from
                ? `Nothing has interrupted the platform since ${formatDate(data.observed_from)}.`
                : "Nothing has interrupted the platform in the measured window."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {incidents.map((incident) => {
              const { label, tone } = describeIncident(incident);
              return (
                <li
                  key={`${incident.started_at}-${incident.duration_seconds}`}
                  className="flex items-start gap-3 px-3.5 py-3 sm:px-4"
                >

                  <span
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                      toneBox[tone],
                    )}
                  >
                    {incident.kind === "outage" ? (
                      <TriangleAlert className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-sm font-semibold tabular-nums">
                        Down {formatDuration(incident.duration_seconds)}
                      </p>
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                          toneBadge[tone],
                        )}
                      >
                        {label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {formatDateTime(incident.started_at)} → {formatClock(incident.ended_at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        Downtime is observed, not estimated: the panel writes a heartbeat while it
        runs, and the next start records the gap it finds. A gap under two minutes
        is reported as a restart, longer as an outage.
      </p>
    </div>
  );
}
