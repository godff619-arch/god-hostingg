// Admin Error Center (/admin/errors) — every platform failure, grouped.
//
// The list is deliberately not a log tail. One row is one *kind* of failure with
// an occurrence count and a first/last-seen window, because the operational
// question is "what is broken and is it still happening", which a stream of
// identical lines answers badly. Rows are written by lib/errorCenter.ts.
//
// Resolving is an operator note, not a fix: if the same failure recurs the server
// re-opens the group, so nothing here can permanently hide a live problem.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminGet, adminSend, adminDownload } from "@/lib/adminApi";
import { ListError, ListSkeleton, ListEmpty } from "@/components/admin/AdminList";
import type { ErrorGroup, ErrorsResponse } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const STATUS_FILTERS = ["open", "resolved", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Source → chip colour. Unknown sources fall back to neutral rather than break.
 * The theme ships five categorical tokens for nine sources, so a couple of hues
 * repeat; the chip always carries its label, so colour is a hint, not the data.
 */
const SOURCE_TONE: Record<string, string> = {
  api: "border-brand/30 bg-brand/10 text-brand",
  deploy: "border-chart-5/25 bg-chart-5/10 text-chart-5",
  docker: "border-chart-1/25 bg-chart-1/10 text-chart-1",
  git: "border-chart-3/25 bg-chart-3/10 text-chart-3",
  nginx: "border-chart-2/25 bg-chart-2/10 text-chart-2",
  cert: "border-success-border bg-success-surface text-success",
  webhook: "border-chart-4/25 bg-chart-4/10 text-chart-4",
  backup: "border-chart-5/25 bg-chart-5/10 text-chart-5",
  internal: "border-danger-border bg-danger-surface text-danger",
};

function sourceTone(source: string): string {
  return SOURCE_TONE[source] ?? "border-border/60 bg-secondary/50 text-muted-foreground";
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** "3m ago" / "2h ago" — the answer to "is this still happening". */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function AdminErrors() {
  const [data, setData] = useState<ErrorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Any filter change invalidates the current page number.
  useEffect(() => {
    setPage(1);
  }, [status, source, search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status,
        source,
        q: search,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      setData(await adminGet<ErrorsResponse>(`/errors?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load errors");
    } finally {
      setLoading(false);
    }
  }, [status, source, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.errors ?? [];
  const total = data?.total ?? 0;
  const summary = data?.summary;

  // Export honours the active status/source/search filters (server re-applies them).
  const exportErrors = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ format, status, source, q: search });
      await adminDownload(`/errors/export?${params.toString()}`, `error-events.${format}`);
      toast.success(`Exported errors as ${format.toUpperCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  const sources = useMemo(() => summary?.sources ?? [], [summary]);

  return (
    <>
      <PageHeader
        title="Error Center"
        description="Every platform failure, grouped by kind. A group re-opens automatically if the same error happens again."
        icon={TriangleAlert}
        meta={
          summary ? (
            <>
              <StatChip
                label="Open"
                value={summary.open}
                tone={summary.open > 0 ? "warning" : "success"}
              />
              <StatChip
                label="Active 24h"
                value={summary.active_24h}
                tone={summary.active_24h > 0 ? "warning" : "neutral"}
                pulse={summary.active_24h > 0}
              />
              <StatChip label="Resolved" value={summary.resolved} tone="neutral" />
            </>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting || total === 0}
              onClick={() => void exportErrors("csv")}
              title="Download the filtered errors as CSV"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting || total === 0}
              onClick={() => void exportErrors("json")}
              title="Download the filtered errors as JSON"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !summary?.open}
              onClick={() =>
                void act(
                  () => adminSend("/errors/resolve-all", "POST", source ? { source } : undefined),
                  source ? `Resolved all ${source} errors` : "Resolved all open errors",
                )
              }
            >
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Resolve all{source ? ` (${source})` : ""}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !summary?.resolved}
              onClick={() =>
                void act(() => adminSend("/errors", "DELETE"), "Cleared resolved groups")
              }
            >
              <Eraser className="mr-1.5 h-3.5 w-3.5" />
              Clear resolved
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void load()}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </Button>
          </>
        }
      />

      {/* Filters: status, then a source breakdown that doubles as a facet count. */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-xl border px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                status === s
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
          <form
            className="ml-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query.trim());
            }}
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Message, route, request id…"
                className="h-9 w-full pl-8 sm:w-72"
              />
            </div>
            <Button type="submit" variant="outline" size="sm" className="h-9">
              Search
            </Button>
          </form>
        </div>

        {sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setSource("")}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                source === ""
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              All sources
            </button>
            {sources.map((s) => (
              <button
                key={s.source}
                type="button"
                onClick={() => setSource(source === s.source ? "" : s.source)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                  source === s.source
                    ? sourceTone(s.source)
                    : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
                )}
              >
                {s.source}
                <span className="ml-1.5 tabular-nums opacity-70">{s.occurrences}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <ListError message={error} onRetry={() => void load()} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center">
          <Check className="mx-auto h-8 w-8 text-success" />
          <p className="mt-3 text-sm font-medium text-foreground">
            {status === "open" ? "No open errors." : "Nothing to show."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {status === "open"
              ? "The platform has not recorded an unresolved failure."
              : "Try a different filter."}
          </p>
        </div>
      ) : (
        <div className="stagger-in space-y-2.5">
          {rows.map((group) => (
            <ErrorCard
              key={group.id}
              group={group}
              expanded={openId === group.id}
              busy={busy}
              onToggle={() => setOpenId(openId === group.id ? null : group.id)}
              onResolve={() =>
                void act(() => adminSend(`/errors/${group.id}/resolve`, "POST"), "Marked resolved")
              }
              onReopen={() =>
                void act(() => adminSend(`/errors/${group.id}/reopen`, "POST"), "Re-opened")
              }
              onDelete={() =>
                void act(() => adminSend(`/errors/${group.id}`, "DELETE"), "Group deleted")
              }
            />
          ))}
        </div>
      )}

      {!loading && total > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing{" "}
            <span className="font-semibold text-foreground">
              {rangeStart}–{rangeEnd}
            </span>{" "}
            of <span className="font-semibold text-foreground">{total}</span> groups
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

/**
 * One group. Collapsed it answers what/where/how-often; expanded it fetches the
 * stack trace on demand, so a list of 20 groups never ships 20 stack traces.
 */
function ErrorCard({
  group,
  expanded,
  busy,
  onToggle,
  onResolve,
  onReopen,
  onDelete,
}: {
  group: ErrorGroup;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const [detail, setDetail] = useState<string | null>(group.detail ?? null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const resolved = group.resolved_at !== null;

  useEffect(() => {
    if (!expanded || detail !== null) return;
    setLoadingDetail(true);
    adminGet<{ error_group: ErrorGroup }>(`/errors/${group.id}`)
      .then((res) => setDetail(res.error_group.detail ?? ""))
      .catch(() => setDetail(""))
      .finally(() => setLoadingDetail(false));
  }, [expanded, detail, group.id]);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-card shadow-sm transition-colors",
        resolved ? "border-border/40 opacity-75" : "border-border/60",
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <span
          className={cn(
            "mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl border sm:flex",
            group.level === "warn"
              ? "border-warning-border bg-warning-surface text-warning"
              : "border-danger-border bg-danger-surface text-danger",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
                sourceTone(group.source),
              )}
            >
              {group.source}
            </span>
            {group.status_code ? (
              <span className="rounded-md border border-border/60 bg-secondary/50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {group.status_code}
              </span>
            ) : null}
            {resolved ? (
              <span className="rounded-md border border-success-border bg-success-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-success">
                Resolved
              </span>
            ) : null}
            <span className="rounded-md border border-border/60 bg-secondary/50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
              ×{group.count}
            </span>
          </div>

          <button
            type="button"
            onClick={onToggle}
            className="mt-2 block w-full text-left"
            aria-expanded={expanded}
          >
            <p className="break-words text-sm font-medium text-foreground">{group.message}</p>
          </button>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {group.route && <span className="font-mono">{group.route}</span>}
            <span title={formatDateTime(group.last_seen_at)}>
              last {relative(group.last_seen_at)}
            </span>
            <span title={formatDateTime(group.first_seen_at)}>
              first {relative(group.first_seen_at)}
            </span>
            {group.user && <span>{group.user.email}</span>}
            {group.resource && <span className="font-mono">{group.resource}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {resolved ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onReopen}
              title="Re-open this group"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Re-open
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={onResolve}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Resolve
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 border-border/60 text-danger hover:bg-danger-surface"
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete group"
            title="Delete this group"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Fingerprint <span className="font-mono">{group.fingerprint.slice(0, 12)}</span>
            </span>
            {group.request_id && (
              <span className="flex items-center gap-1.5">
                Request <span className="font-mono">{group.request_id}</span>
                <button
                  type="button"
                  aria-label="Copy request id"
                  className="hover:text-foreground"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(group.request_id ?? "")
                      .then(() => toast.success("Request id copied"))
                      .catch(() => toast.error("Could not copy"));
                  }}
                >
                  <Copy className="h-3 w-3" />
                </button>
              </span>
            )}
            <span>Last seen {formatDateTime(group.last_seen_at)}</span>
          </div>
          {loadingDetail ? (
            <div className="h-24 animate-pulse rounded-xl bg-secondary/30" />
          ) : detail ? (
            <pre className="max-h-72 overflow-auto rounded-xl border border-border/50 bg-secondary/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {detail}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              No stack trace was captured for this group.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
