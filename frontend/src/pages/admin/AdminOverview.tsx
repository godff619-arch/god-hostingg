// Admin Overview (/admin) — platform-wide stat tiles + live system health meters.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Boxes,
  Rocket,
  Database,
  Layers,
  Container,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  ChevronRight,
} from "lucide-react";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/adminApi";
import type { AdminOverview as AdminOverviewData } from "@/lib/adminTypes";
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

// CSS meter — matches the SystemOverview bar style.
function Meter({
  label,
  value,
  sublabel,
  icon: Icon,
}: {
  label: string;
  value: number;
  sublabel?: string;
  icon: typeof Cpu;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-xl border border-border/50 bg-secondary/30 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-4 w-4" />
          {label}
        </span>
        <span className="text-sm font-bold tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full transition-all duration-500", meterTone(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
      {sublabel && (
        <p className="mt-1.5 truncate text-xs text-muted-foreground">{sublabel}</p>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  breakdown,
}: {
  label: string;
  value: number;
  icon: typeof Users;
  accent: string;
  breakdown?: { label: string; value: number; tone?: string }[];
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex items-center gap-3">
        <span className={cn("flex h-10 w-10 items-center justify-center rounded-xl", accent)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-bold tabular-nums leading-tight">{value}</p>
        </div>
      </div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 pt-3 text-xs">
          {breakdown.map((b) => (
            <span key={b.label} className="text-muted-foreground">
              {b.label}{" "}
              <span className={cn("font-semibold tabular-nums", b.tone ?? "text-foreground")}>
                {b.value}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const QUICK_LINKS: { to: string; label: string; icon: typeof Users }[] = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/apps", label: "Applications", icon: Boxes },
  { to: "/admin/deployments", label: "Deployments", icon: Rocket },
  { to: "/admin/plans", label: "Plans", icon: Layers },
  { to: "/admin/settings", label: "Settings", icon: LayoutDashboard },
];

export default function AdminOverview() {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await adminGet<AdminOverviewData>("/overview");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 5000);
    return () => clearInterval(interval);
  }, [fetchOverview]);

  return (
    <>
      <PageHeader
        title="Admin Overview"
        description="Platform-wide health, usage, and quick access to management tools."
        icon={LayoutDashboard}
        meta={
          data ? (
            <StatChip
              label="Health"
              value={data.health === "ok" ? "Healthy" : "Degraded"}
              tone={data.health === "ok" ? "success" : "warning"}
            />
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchOverview}
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

      {loading && !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-2xl border border-border/60 bg-secondary/20"
            />
          ))}
        </div>
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatTile
              label="Users"
              value={data.users.total}
              icon={Users}
              accent="bg-brand/10 text-brand"
              breakdown={[
                { label: "Active", value: data.users.active, tone: "text-emerald-500" },
                { label: "Suspended", value: data.users.suspended, tone: "text-red-500" },
                { label: "Pending", value: data.users.pending, tone: "text-blue-500" },
              ]}
            />
            <StatTile
              label="Applications"
              value={data.apps.total}
              icon={Boxes}
              accent="bg-cyan-500/10 text-cyan-500"
              breakdown={[
                { label: "Running", value: data.apps.running, tone: "text-emerald-500" },
                { label: "Stopped", value: data.apps.stopped },
                { label: "Failed", value: data.apps.failed, tone: "text-red-500" },
              ]}
            />
            <StatTile
              label="Deployments today"
              value={data.deployments.today}
              icon={Rocket}
              accent="bg-purple-500/10 text-purple-500"
              breakdown={[
                { label: "Running", value: data.deployments.running, tone: "text-amber-500" },
                { label: "Failed", value: data.deployments.failedToday, tone: "text-red-500" },
              ]}
            />
            <StatTile
              label="Databases"
              value={data.databases.total}
              icon={Database}
              accent="bg-amber-500/10 text-amber-500"
            />
            <StatTile
              label="Plans"
              value={data.plans.total}
              icon={Layers}
              accent="bg-rose-500/10 text-rose-500"
            />
            <StatTile
              label="Containers running"
              value={data.containers.running}
              icon={Container}
              accent="bg-emerald-500/10 text-emerald-500"
            />
          </div>

          <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                {data.health === "ok" ? (
                  <ShieldCheck className="h-5 w-5 text-emerald-500" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-amber-500" />
                )}
                System health
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/40 px-2.5 py-1 text-xs font-medium">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                {data.system.uptimeFormatted}
              </span>
            </div>

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
                value={data.system.diskUsedPercent ?? 0}
                sublabel={data.system.diskUsedPercent === null ? "Unavailable" : undefined}
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
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {QUICK_LINKS.map(({ to, label, icon: Icon }) => (
              <Button
                key={to}
                asChild
                variant="outline"
                className="h-auto justify-between border-border/60 px-4 py-3"
              >
                <Link to={to}>
                  <span className="flex items-center gap-2 font-medium">
                    <Icon className="h-4 w-4 text-brand" />
                    {label}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
