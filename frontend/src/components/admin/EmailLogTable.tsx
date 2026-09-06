// The mail log — §21. Every mail the platform tried to send, and why it failed.
//
// The point of this table is that it is not a claim: each row is the outcome the
// transport actually returned. `queued` is amber, not green — nothing has left the
// building. `retryable` is decided by the server (a row written before bodies were
// stored has nothing to re-send), so the button is never offered where it would fail.
//
// Bodies are fetched one at a time by the detail dialog. Putting them in the list
// response would make a page of 25 mails megabytes of HTML nobody is reading.

import { useCallback, useEffect, useState } from "react";
import { Loader2, MailWarning, RefreshCw, RotateCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DetailRow,
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Pagination,
  SearchField,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type {
  DrainResult,
  EmailLogResponse,
  EmailLogRow,
  EmailLogsResponse,
  SendOutcome,
} from "@/lib/adminCommsTypes";
import { mailTone } from "@/lib/adminCommsTypes";
import { formatDateTime, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

function MailDetailDialog({
  logId,
  canSend,
  onClose,
  onRetried,
}: {
  logId: string;
  canSend: boolean;
  onClose: () => void;
  onRetried: () => void;
}) {
  const [data, setData] = useState<EmailLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminGet<EmailLogResponse>(`/email/logs/${logId}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that mail");
    }
  }, [logId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async () => {
    setRetrying(true);
    try {
      const res = await adminSend<SendOutcome>(`/email/logs/${logId}/retry`, "POST");
      if (res.status === "sent") toast.success(res.message);
      else if (res.status === "queued") toast.warning(res.message);
      else toast.error(res.error || res.message);
      await load();
      onRetried();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not retry that mail.");
    } finally {
      setRetrying(false);
    }
  };

  const log = data?.log;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{log?.subject ?? "Mail"}</DialogTitle>
          <DialogDescription>
            {log ? `To ${log.to_email}` : "Loading the stored copy of this mail…"}
          </DialogDescription>
        </DialogHeader>

        {error && <ListError message={error} onRetry={load} />}
        {!log && !error && <ListSkeleton rows={4} />}

        {log && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/60 bg-card px-4 py-2">
              <DetailRow label="Status">
                <ToneBadge label={humanize(log.status)} tone={mailTone(log.status)} />
              </DetailRow>
              <DetailRow label="From">{log.from_email || "—"}</DetailRow>
              <DetailRow label="Template">
                {log.template_key ? (
                  <span className="font-mono text-[11px]">{log.template_key}</span>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Kind">{humanize(log.kind)}</DetailRow>
              <DetailRow label="Attempts">{log.attempts}</DetailRow>
              <DetailRow label="Created">{formatDateTime(log.created_at)}</DetailRow>
              <DetailRow label="Last attempt">{formatDateTime(log.last_attempt_at)}</DetailRow>
              <DetailRow label="Delivered">
                {log.sent_at ? (
                  formatDateTime(log.sent_at)
                ) : (
                  <span className="text-muted-foreground">not yet</span>
                )}
              </DetailRow>
              {data?.user && (
                <DetailRow label="Account">
                  <span className="block">{data.user.name || data.user.email}</span>
                  <span className="block text-xs text-muted-foreground">{data.user.email}</span>
                </DetailRow>
              )}
              {log.related_type && (
                <DetailRow label="About">
                  {humanize(log.related_type)}{" "}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {log.related_id}
                  </span>
                </DetailRow>
              )}
            </div>

            {log.error && (
              <div className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2.5 text-xs text-danger">
                <span className="font-semibold">The server said:</span>{" "}
                <span className="break-words font-mono">{log.error}</span>
              </div>
            )}

            {log.body_html ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  The mail as it was sent
                </p>
                <iframe
                  title="Sent mail"
                  sandbox=""
                  srcDoc={log.body_html}
                  className="h-[46vh] w-full rounded-xl border border-border/60 bg-white"
                />
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                No body was stored for this row, so it cannot be re-sent or re-read. Trigger it again
                from the invoice or ticket it came from.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {log?.retryable && (
            <Button onClick={retry} disabled={!canSend || retrying}>
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Try again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EmailLogTable({
  canSend,
  smtpReady,
  reloadKey,
}: {
  canSend: boolean;
  /** Drives whether Drain is offered — the endpoint 409s when SMTP is off. */
  smtpReady: boolean;
  /** Bumped by the page after a test send so the log picks the new row up. */
  reloadKey?: number;
}) {
  const [rows, setRows] = useState<EmailLogRow[]>([]);
  const [data, setData] = useState<EmailLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, kind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (status !== "all") params.set("status", status);
      if (kind !== "all") params.set("kind", kind);
      const res = await adminGet<EmailLogsResponse>(`/email/logs?${params.toString()}`);
      setRows(res.logs);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the mail log");
    } finally {
      setLoading(false);
    }
  }, [query, status, kind, page]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const drain = async () => {
    setDraining(true);
    try {
      const res = await adminSend<DrainResult>("/email/drain", "POST", { limit: 50 });
      if (res.attempted === 0) toast.info("Nothing was waiting in the queue.");
      else if (res.failed > 0)
        toast.warning(`${res.sent} sent, ${res.failed} failed. Open a failed row for the reason.`);
      else toast.success(`${res.sent} mail(s) went out.`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not drain the queue.");
    } finally {
      setDraining(false);
    }
  };

  const statusOptions: PillOption[] = [
    { value: "all", label: "All" },
    ...(data?.facets.statuses ?? []).map((f) => ({
      value: f.key,
      label: humanize(f.key),
      count: f.count,
    })),
  ];
  const kindOptions: PillOption[] = [
    { value: "all", label: "Every kind" },
    ...(data?.facets.kinds ?? []).map((f) => ({
      value: f.key,
      label: humanize(f.key),
      count: f.count,
    })),
  ];

  const queued = data?.facets.statuses.find((s) => s.key === "queued")?.count ?? 0;

  return (
    <div className="space-y-4">
      {queued > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2">
            <MailWarning className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {queued} mail{queued === 1 ? "" : "s"} waiting to be delivered.
              {smtpReady
                ? " They go out automatically every five minutes."
                : " SMTP is off or incomplete — configure it and they will go out."}
            </span>
          </span>
          {smtpReady && canSend && (
            <Button variant="outline" size="sm" onClick={drain} disabled={draining} className="shrink-0 self-start sm:self-auto">
              {draining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
              Send them now
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search recipient, subject or template…"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-10 w-10 shrink-0 border-border/60"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        </div>
        <FilterPills options={statusOptions} value={status} onChange={setStatus} />
        {kindOptions.length > 2 && <FilterPills options={kindOptions} value={kind} onChange={setKind} />}
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading && rows.length === 0 ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No mail matches these filters."
          hint={
            query || status !== "all" || kind !== "all"
              ? "Clear the search or pick another status."
              : "Nothing has been sent yet. Send a test from the SMTP tab to check the wiring."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                onClick={() => setOpenId(row.id)}
                className="press cursor-pointer rounded-2xl border border-border/60 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{row.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.to_email}
                    </span>
                  </span>
                  <ToneBadge label={humanize(row.status)} tone={mailTone(row.status)} />
                </div>
                {row.error && (
                  <p className="mt-2 line-clamp-2 text-[11px] text-danger">{row.error}</p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {formatDateTime(row.created_at)}
                  {row.attempts > 1 ? ` · ${row.attempts} attempts` : ""}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Template</th>
                  <th className="px-4 py-3">Attempts</th>
                  <th className="px-4 py-3">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(row.id)}
                    className="cursor-pointer hover:bg-secondary/30"
                    title="Open the stored copy"
                  >
                    <td className="max-w-[220px] px-4 py-3">
                      <span className="block truncate">{row.to_email}</span>
                    </td>
                    <td className="max-w-[280px] px-4 py-3">
                      <span className="block truncate font-medium">{row.subject}</span>
                      {row.error && (
                        <span className="mt-0.5 block truncate text-[11px] text-danger" title={row.error}>
                          {row.error}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(row.status)} tone={mailTone(row.status)} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {row.template_key || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{row.attempts}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDateTime(row.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            noun="mails"
            onPage={setPage}
          />
        </>
      )}

      {openId && (
        <MailDetailDialog
          logId={openId}
          canSend={canSend}
          onClose={() => setOpenId(null)}
          onRetried={load}
        />
      )}
    </div>
  );
}
