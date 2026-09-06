// Admin Invoices (/admin/invoices) — §11.
//
// An invoice is a document, not money. That distinction drives the whole page:
// "Paid" and "Outstanding" are separate figures because a pending invoice is a
// claim we have not collected, and nothing on this page can collect it. The three
// actions (void, mark paid, send) all live in the detail dialog, since each needs
// the invoice's current status to be legal.
//
// `pdf_path` is null until a renderer exists, so Download serves the plain-text
// rendering the customer-facing route already produces. The button says
// "Download" rather than "PDF" for that reason.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AccountCell,
  Field,
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Metric,
  MetricStrip,
  Pagination,
  SearchField,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { InvoiceDetailDialog } from "@/components/admin/InvoiceDetailDialog";
import { adminDownload, adminGet } from "@/lib/adminApi";
import type { InvoiceRow, InvoicesResponse } from "@/lib/adminBillingTypes";
import { billingTone, formatDate, humanize, isPast } from "@/lib/adminFormat";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function AdminInvoices() {
  const { can } = useAdminMe();
  const mayManage = can("invoices.manage");

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<InvoicesResponse["totals"] | null>(null);
  const [statusFacets, setStatusFacets] = useState<InvoicesResponse["facets"]["statuses"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, from, to]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [query, status, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = filterParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await adminGet<InvoicesResponse>(`/invoices?${params.toString()}`);
      setRows(res.invoices);
      setTotal(res.total);
      setTotals(res.totals);
      setStatusFacets(res.facets.statuses);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoices");
    } finally {
      setLoading(false);
    }
  }, [filterParams, page]);

  useEffect(() => {
    load();
  }, [load]);

  const statusOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "All" },
      ...statusFacets.map((s) => ({ value: s.key, label: humanize(s.key), count: s.count })),
    ],
    [statusFacets],
  );

  const exportCsv = async () => {
    try {
      await adminDownload(`/invoices/export?${filterParams().toString()}`, "invoices.csv");
      toast.success("Export downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  };

  const downloadOne = async (row: InvoiceRow) => {
    try {
      await adminDownload(`/invoices/${row.id}/download`, `${row.number}.txt`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed.");
    }
  };

  const overdue = (row: InvoiceRow) =>
    row.status !== "paid" && row.status !== "void" && isPast(row.due_at);

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Billing documents, what has been collected against them, and what is still owed."
        icon={FileText}
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} className="border-border/60">
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <MetricStrip>
        <Metric
          label="Paid"
          value={totals?.paid_label ?? "—"}
          tone="success"
          hint="Settled invoices in this filter"
          loading={loading}
        />
        <Metric
          label="Outstanding"
          value={totals?.outstanding_label ?? "—"}
          tone={totals && totals.outstanding_cents > 0 ? "warning" : "neutral"}
          hint="Pending and failed"
          loading={loading}
        />
        <Metric label="Invoices" value={total} hint="Matching the current filter" loading={loading} />
        <Metric
          label="Overdue on this page"
          value={rows.filter(overdue).length}
          tone={rows.some(overdue) ? "danger" : "neutral"}
          hint="Past the due date, not paid"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search invoice number, id or account…"
        />
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <FilterPills options={statusOptions} value={status} onChange={setStatus} />
          <div className="flex items-end gap-2">
            <Field label="Issued from">
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-[9.5rem]"
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-[9.5rem]"
              />
            </Field>
            {(from || to) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
              >
                Clear dates
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No invoices match these filters."
          hint={
            query || status !== "all" || from || to
              ? "Clear the search or widen the date range."
              : "An invoice is written when a subscription period is billed."
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
                    <span className="block font-mono text-xs text-muted-foreground">
                      {row.number}
                    </span>
                    <AccountCell
                      workspaceName={row.workspace_name}
                      email={row.user_email}
                      userId={row.user_id}
                    />
                  </span>
                  <span className="shrink-0 text-right font-bold tabular-nums">
                    {row.amount_label}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                  {overdue(row) && <ToneBadge label="Overdue" tone="danger" />}
                  {row.marked_paid_by && <ToneBadge label="Settled by hand" tone="warning" />}
                  <span className="text-[11px] text-muted-foreground">
                    issued {formatDate(row.issued_at)}
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Issued</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(row.id)}
                    className="cursor-pointer hover:bg-secondary/30"
                  >
                    <td className="px-4 py-3">
                      <span className="block font-mono text-xs font-semibold">{row.number}</span>
                      {row.sent_count > 0 && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Mail className="h-3 w-3" /> sent {row.sent_count}×
                        </span>
                      )}
                    </td>
                    <td className="max-w-[220px] px-4 py-3">
                      <AccountCell
                        workspaceName={row.workspace_name}
                        email={row.user_email}
                        userId={row.user_id}
                      />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {row.amount_label}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                        {row.marked_paid_by && (
                          <ToneBadge
                            label="by hand"
                            tone="warning"
                            title={row.marked_paid_reason ?? "Settled outside the provider"}
                          />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDate(row.issued_at)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      <span className={cn(overdue(row) && "font-semibold text-danger")}>
                        {formatDate(row.due_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download"
                          aria-label="Download invoice"
                          onClick={() => downloadOne(row)}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Open invoice"
                          aria-label="Open invoice"
                          onClick={() => setOpenId(row.id)}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            noun="invoices"
            onPage={setPage}
          />
        </>
      )}

      <InvoiceDetailDialog
        invoiceId={openId}
        onClose={() => setOpenId(null)}
        onDone={load}
        mayManage={mayManage}
      />
    </>
  );
}
