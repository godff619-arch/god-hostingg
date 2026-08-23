// Admin Operations Center (/admin/operations) — live operational health of the
// control plane itself: process, database, Docker engine, host resources and
// recent deployment activity. Every value is measured server-side at request
// time; unavailable subsystems are shown honestly (no faked "healthy").

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Database,
  Container,
  Server,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { adminGet } from "@/lib/adminApi";
import type { AdminOperations as OpsData } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytesPerSec) / Math.log(k)));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function meterTone(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

// Deployment status → StatusBadge vocabulary (its map has no success/failed).
function deployBadgeStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "success" || s === "deployed" || s === "running") return "running";
  if (s === "failed" || s === "error") return "error";
  if (s === "in_progress" || s === "building") return "building";
  return "pending";
}

// A single CPU/mem/disk meter bar.
function Meter({
  label,
  value,
  sublabel,
  icon: Icon,
}: {
  label: string;
  value: number | null;
  sublabel?: string;
  icon: typeof Cpu;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-xl border border-border/50 bg-secondary/30 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-4 w-4" />
          {label}
        </span>
        <span className="text-sm font-bold tabular-nums">
          {value === null ? "N/A" : `${pct.toFixed(1)}%`}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full transition-all duration-500", meterTone(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
      {sublabel && <p className="mt-1.5 truncate text-xs text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

// One dependency health row (DB / Docker), with an up/down dot.
function HealthRow({
  icon: Icon,
  label,
  ok,
  detail,
  okText = "Reachable",
  downText = "Unreachable",
}: {
  icon: typeof Server;
  label: string;
  ok: boolean;
  detail?: string;
  okText?: string;
  downText?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-secondary/30 px-4 py-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {label}
      </span>
      <span className="flex items-center gap-2 text-sm">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500" />
        )}
        <span className={cn("font-semibold", ok ? "text-emerald-500" : "text-red-500")}>
          {ok ? okText : downText}
        </span>
        {detail && <span className="text-xs text-muted-foreground">· {detail}</span>}
      </span>
    </div>
  );
}

export default function AdminOperations() {
  const [data, setData] = useState<OpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOps = useCallback(async () => {
    try {
      const res = await adminGet<OpsData>("/operations");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load operations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOps();
    const interval = setInterval(fetchOps, 5000);
    return () => clearInterval(interval);
  }, [fetchOps]);

  const uptimeText = (secs: number): string => {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  return (
    <>
      <PageHeader
        title="Operations Center"
        description="Live health of the control plane — process, database, Docker engine and host."
        icon={Activity}
        meta={
          data ? (
            <StatChip
              label="Status"
              value={data.health === "ok" ? "Operational" : "Degraded"}
              tone={data.health === "ok" ? "success" : "warning"}
            />
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchOps}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {data?.maintenance.enabled && (
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>Maintenance mode is on.</strong> {data.maintenance.reason}
          </span>
        </div>
      )}

      {data && !data.docker.daemonReachable && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-sm text-orange-700 dark:text-orange-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {data.docker.message ||
              "Docker engine is not reachable. Deployments, live logs and container metrics are unavailable until Docker is running."}
          </span>
        </div>
      )}

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-2xl border border-border/60 bg-secondary/20"
            />
          ))}
        </div>
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Control-plane process */}
            <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
              <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
                <Server className="h-5 w-5 text-brand" />
                Control plane
              </h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Uptime</dt>
                  <dd className="font-semibold tabular-nums">
                    {uptimeText(data.instance.uptimeSeconds)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Node</dt>
                  <dd className="font-semibold tabular-nums">{data.instance.nodeVersion}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">PID</dt>
                  <dd className="font-semibold tabular-nums">{data.instance.pid}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Platform</dt>
                  <dd className="font-semibold">{data.instance.platform}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">RSS</dt>
                  <dd className="font-semibold tabular-nums">{data.instance.memoryRss}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Heap</dt>
                  <dd className="font-semibold tabular-nums">
                    {data.instance.heapUsed} / {data.instance.heapTotal}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Dependencies */}
            <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
              <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
                {data.health === "ok" ? (
                  <ShieldCheck className="h-5 w-5 text-emerald-500" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-amber-500" />
                )}
                Dependencies
              </h2>
              <div className="space-y-3">
                <HealthRow
                  icon={Database}
                  label={`Database (${data.database.provider})`}
                  ok={data.database.reachable}
                  detail={
                    data.database.latencyMs !== null ? `${data.database.latencyMs} ms` : undefined
                  }
                />
                <HealthRow
                  icon={Container}
                  label="Docker engine"
                  ok={data.docker.daemonReachable}
                  okText="Running"
                  downText="Not reachable"
                  detail={
                    data.docker.daemonReachable
                      ? [
                          data.docker.version ? `v${data.docker.version}` : null,
                          data.docker.runningContainers !== null
                            ? `${data.docker.runningContainers} running`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || undefined
                      : data.docker.cliAvailable
                        ? "CLI installed, daemon stopped"
                        : "CLI not found"
                  }
                />
              </div>
            </div>
          </div>

          {/* Host resources */}
          <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Cpu className="h-5 w-5 text-brand" />
                Host resources
              </h2>
              {data.system && (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/40 px-2.5 py-1 text-xs font-medium">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {data.system.uptimeFormatted}
                </span>
              )}
            </div>
            {data.system ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Meter label="CPU" value={data.system.cpuPercent} icon={Cpu} />
                  <Meter
                    label="Memory"
                    value={data.system.memUsedPercent}
                    sublabel={`${data.system.memUsed} / ${data.system.memTotal}`}
                    icon={MemoryStick}
                  />
                  <Meter
                    label="Disk"
                    value={data.system.diskUsedPercent}
                    sublabel={
                      data.system.diskUsedPercent === null
                        ? "Unavailable"
                        : `${data.system.diskUsed} / ${data.system.diskTotal}`
                    }
                    icon={HardDrive}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="flex items-center justify-between rounded-xl border border-border/50 bg-secondary/30 px-4 py-3">
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <ArrowDownToLine className="h-4 w-4 text-emerald-500" />
                      Download
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatSpeed(data.system.rxSpeed)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-border/50 bg-secondary/30 px-4 py-3">
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <ArrowUpFromLine className="h-4 w-4 text-cyan-500" />
                      Upload
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatSpeed(data.system.txSpeed)}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Host statistics are unavailable.</p>
            )}
          </div>

          {/* Recent deployments */}
          <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Activity className="h-5 w-5 text-brand" />
                Recent deployments
              </h2>
              <Link
                to="/admin/deployments"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
              >
                View all <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
            {data.deployments.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deployments recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border/40">
                {data.deployments.recent.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      {d.projectId ? (
                        <Link
                          to={`/projects/${d.projectId}`}
                          className="truncate font-medium hover:text-brand hover:underline"
                        >
                          {d.projectName || d.projectId}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-muted-foreground">
                          {d.projectName || "Unknown project"}
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {new Date(d.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={deployBadgeStatus(d.status)} size="sm" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

