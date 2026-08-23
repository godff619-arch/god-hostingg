// Admin Deployments (/admin/deployments) — platform-wide deployment history.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Rocket,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { adminGet } from "@/lib/adminApi";
import type { DeploymentRow, DeploymentsResponse } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const STATUS_FILTERS = ["all", "queued", "in_progress", "success", "failed", "cancelled"] as const;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export default function AdminDeployments() {
  const [rows, setRows] = useState<DeploymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [status]);

  const fetchDeployments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: status === "all" ? "" : status,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const res = await adminGet<DeploymentsResponse>(`/deployments?${params.toString()}`);
      setRows(res.deployments);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deployments");
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <>
      <PageHeader
        title="Deployments"
        description="Deployment activity across all projects and users."
        icon={Rocket}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchDeployments}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors",
              status === s
                ? "border-brand/30 bg-brand/10 text-brand"
                : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "all" ? "All" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          No deployments found.
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-3 lg:hidden">
            {rows.map((d) => (
              <article key={d.id} className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/projects/${d.project.id}`} className="font-semibold hover:text-brand hover:underline">
                      {d.project.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {d.owner ? d.owner.email : "Unowned"}
                    </p>
                  </div>
                  <StatusBadge status={d.status} size="sm" />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{d.trigger || "—"}</span>
                  {d.commit_sha && <span className="font-mono">{d.commit_sha.slice(0, 7)}</span>}
                  <span>{formatDuration(d.durationMs)}</span>
                  <span>{formatDateTime(d.created_at)}</span>
                </div>
              </article>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Application</th>
                    <th className="px-4 py-3 font-semibold">Owner</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Trigger</th>
                    <th className="px-4 py-3 font-semibold">Commit</th>
                    <th className="px-4 py-3 font-semibold">Duration</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className="border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40">
                      <td className="px-4 py-3">
                        <Link to={`/projects/${d.project.id}`} className="font-semibold hover:text-brand hover:underline">
                          {d.project.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {d.owner ? (
                          <>
                            <p className="font-medium">{d.owner.name}</p>
                            <p className="text-xs text-muted-foreground">{d.owner.email}</p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Unowned</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={d.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{d.trigger || "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {d.commit_sha ? d.commit_sha.slice(0, 7) : "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatDuration(d.durationMs)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatDateTime(d.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && total > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing{" "}
            <span className="font-semibold text-foreground">
              {rangeStart}–{rangeEnd}
            </span>{" "}
            of <span className="font-semibold text-foreground">{total}</span> deployments
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-muted-foreground">
              {page} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
