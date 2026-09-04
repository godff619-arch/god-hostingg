// Admin Audit Logs (/admin/audit-logs) — the record of every privileged action.
//
// One row per entry in `audit_logs`, written by `writeAudit` on each admin
// mutation: who did it, what they touched, from which IP, and the metadata the
// call recorded. Nothing is summarised or invented — if an action is not in the
// table it was never written, which is itself the answer to "did this happen?".
//
// Filtering is server-side (`action` substring, `userId` exact) so it applies to
// the whole history rather than the page in view, and the export downloads that
// same filtered set. Retention is shown because a log that silently ages out
// would otherwise look like a log that never recorded anything.

import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminDownload, adminGet } from "@/lib/adminApi";
import type { AdminSettings, AuditLogsResponse, AuditRow } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

/**
 * Destructive verbs get the danger tone so a delete never reads like a read.
 * Matched on the trailing verb of `resource.verb`, which is the convention
 * `writeAudit` callers follow (`user.delete`, `plan.duplicate`, `audit.export`).
 */
const DESTRUCTIVE = /\.(delete|destroy|remove|purge|suspend|revoke|reject|reset|clear)$/;
const CREATIVE = /\.(create|add|invite|unsuspend|restore|resolve|grant)$/;

function actionTone(action: string): string {
  if (DESTRUCTIVE.test(action)) return "border-danger-border bg-danger-surface text-danger";
  if (CREATIVE.test(action)) return "border-success-border bg-success-surface text-success";
  return "border-border bg-secondary/50 text-foreground";
}

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso, time: "" };
  return {
    date: d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

/**
 * Metadata arrives as whatever the calling site passed. Prisma hands back parsed
 * JSON, but a string that happens to hold JSON is still worth pretty-printing,
 * so both are handled and anything else is printed as-is rather than dropped.
 */
function formatMetadata(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AdminAuditLogs() {
  const [data, setData] = useState<AuditLogsResponse | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  /** Set from a row, so "everything this account did" is one click. */
  const [actor, setActor] = useState<{ id: string; label: string } | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => window.clearTimeout(t);
  }, [q]);

  // Any filter change invalidates the page number — page 4 of a new result set
  // is usually empty, which reads as "no matches" when there are plenty.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, actor?.id]);

  const query = useCallback(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (debouncedQ) params.set("action", debouncedQ);
    if (actor) params.set("userId", actor.id);
    return params.toString();
  }, [debouncedQ, actor, page]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<AuditLogsResponse>(`/audit-logs?${query()}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Retention lives in platform settings; read once so the footer can say how far
  // back this table can possibly go.
  useEffect(() => {
    adminGet<AdminSettings>("/settings")
      .then((s) => setRetentionDays(s.audit_retention_days))
      .catch(() => setRetentionDays(null));
  }, []);

  const exportAs = async (format: "csv" | "json") => {
    setExporting(format);
    try {
      const params = new URLSearchParams({ format });
      if (debouncedQ) params.set("action", debouncedQ);
      if (actor) params.set("userId", actor.id);
      await adminDownload(`/audit-logs/export?${params}`, `audit-logs.${format}`);
      toast.success(`Exported as ${format.toUpperCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(debouncedQ || actor);

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Every privileged action on this platform — who took it, what it touched, and from where."
        icon={ScrollText}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => exportAs("csv")}
              disabled={exporting !== null}
              className="h-10 gap-1.5 border-border/60 bg-background px-3 text-xs font-medium hover:bg-secondary/80"
            >
              {exporting === "csv" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              CSV
            </Button>
            <Button
              variant="outline"
              onClick={() => exportAs("json")}
              disabled={exporting !== null}
              className="h-10 gap-1.5 border-border/60 bg-background px-3 text-xs font-medium hover:bg-secondary/80"
            >
              {exporting === "json" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              JSON
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchLogs}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
            </Button>
          </div>
        }
      />

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by action — user.suspend, plan., settings…"
            className="h-10 pl-9 font-mono text-xs"
          />
        </div>
        {actor && (
          <button
            type="button"
            onClick={() => setActor(null)}
            className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-brand-ring bg-brand/10 px-3 text-xs font-medium text-foreground transition-colors hover:bg-brand/15"
            title="Clear the actor filter"
          >
            <Filter className="h-3.5 w-3.5 text-brand" />
            <span className="max-w-[220px] truncate">{actor.label}</span>
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
            />
          ))}
        </div>
      ) : !data || data.logs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          {filtered
            ? "No action matches these filters."
            : "No audit entries yet — they appear here as soon as a privileged action is taken."}
        </div>
      ) : (
        <AuditTable
          rows={data.logs}
          expanded={expanded}
          onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
          onFilterActor={setActor}
        />
      )}

      {(total > 0 || retentionDays !== null) && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {total > 0 && (
              <>
                <span className="font-semibold text-foreground">{total.toLocaleString()}</span>{" "}
                {filtered ? "matching " : ""}
                {total === 1 ? "entry" : "entries"}
              </>
            )}
            {total > 0 && retentionDays !== null && " · "}
            {retentionDays !== null && (
              <>
                {retentionDays > 0 ? (
                  <>
                    kept {retentionDays} day{retentionDays === 1 ? "" : "s"}
                  </>
                ) : (
                  "kept forever"
                )}{" "}
                <Link
                  to="/admin/settings"
                  className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                >
                  (change)
                </Link>
              </>
            )}
          </p>
          {total > 0 && (
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
          )}
        </div>
      )}
    </>
  );
}

interface AuditTableProps {
  rows: AuditRow[];
  expanded: string | null;
  onToggle: (id: string) => void;
  onFilterActor: (actor: { id: string; label: string } | null) => void;
}

/** Entries as cards on small screens, a table from `md` up. */
function AuditTable({ rows, expanded, onToggle, onFilterActor }: AuditTableProps) {
  return (
    <>
      {/* Mobile */}
      <div className="space-y-3 md:hidden">
        {rows.map((row) => {
          const when = formatWhen(row.created_at);
          const meta = formatMetadata(row.metadata);
          const open = expanded === row.id;
          return (
            <article
              key={row.id}
              className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  className={cn(
                    "rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium",
                    actionTone(row.action),
                  )}
                >
                  {row.action}
                </span>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {when.date}
                  <br />
                  {when.time}
                </span>
              </div>
              <div className="mt-3 space-y-1.5 text-xs">
                <ActorLine row={row} onFilterActor={onFilterActor} />
                {row.resource && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {row.resource}
                  </p>
                )}
                {row.ip && (
                  <p className="font-mono text-[11px] text-muted-foreground">{row.ip}</p>
                )}
              </div>
              {meta && (
                <MetadataDisclosure open={open} onToggle={() => onToggle(row.id)} meta={meta} />
              )}
            </article>
          );
        })}
      </div>

      {/* Desktop */}
      <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-header">
              <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wider text-subtle">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Resource</th>
                <th className="px-4 py-3 font-medium">IP</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {rows.map((row) => {
                const when = formatWhen(row.created_at);
                const meta = formatMetadata(row.metadata);
                const open = expanded === row.id;
                return (
                  // The metadata panel is a sibling row, so the pair shares one key.
                  <Fragment key={row.id}>
                    <tr className="transition-colors hover:bg-secondary/30">
                      <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-muted-foreground">
                        <span className="text-foreground">{when.date}</span>
                        <span className="ml-2">{when.time}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-block rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium",
                            actionTone(row.action),
                          )}
                        >
                          {row.action}
                        </span>
                      </td>
                      <td className="max-w-[220px] px-4 py-3">
                        <ActorLine row={row} onFilterActor={onFilterActor} />
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        {row.resource ? (
                          <span
                            title={row.resource}
                            className="block truncate font-mono text-[11px] text-muted-foreground"
                          >
                            {row.resource}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-muted-foreground">
                        {row.ip || <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {meta ? (
                          <button
                            type="button"
                            onClick={() => onToggle(row.id)}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-border/60 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            aria-expanded={open}
                          >
                            Details
                            <ChevronDown
                              className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                            />
                          </button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground/40">no detail</span>
                        )}
                      </td>
                    </tr>
                    {meta && open && (
                      <tr className="bg-secondary/20">
                        <td colSpan={6} className="px-4 py-3">
                          <pre className="max-h-64 overflow-auto rounded-lg border border-border/50 bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {meta}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/**
 * The actor, with a click-to-filter affordance. `user_id` is null for internal
 * work and after the account is deleted — the log entry survives the account, so
 * "System" and a deleted actor both have to read as deliberate, not as a gap.
 */
function ActorLine({
  row,
  onFilterActor,
}: {
  row: AuditRow;
  onFilterActor: (actor: { id: string; label: string } | null) => void;
}) {
  if (!row.user_id) {
    return (
      <span className="text-xs text-muted-foreground">
        {row.user?.email ?? "System"}
      </span>
    );
  }
  const label = row.user?.email || row.user_id;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link
        to={`/admin/users/${row.user_id}`}
        className="min-w-0 truncate text-xs font-medium text-foreground underline decoration-border underline-offset-2 transition-colors hover:text-brand hover:decoration-brand"
        title={row.user?.name ? `${row.user.name} · ${label}` : label}
      >
        {label}
      </Link>
      <button
        type="button"
        onClick={() => onFilterActor({ id: row.user_id as string, label })}
        title="Show only this account"
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Filter className="h-3 w-3" />
      </button>
    </span>
  );
}

/** Mobile metadata toggle — the desktop table uses a second row instead. */
function MetadataDisclosure({
  open,
  onToggle,
  meta,
}: {
  open: boolean;
  onToggle: () => void;
  meta: string;
}) {
  return (
    <div className="mt-3 border-t border-border/50 pt-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-lg border border-border/60 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        Details
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-border/50 bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {meta}
        </pre>
      )}
    </div>
  );
}
