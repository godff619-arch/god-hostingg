// Admin Refunds (/admin/refunds) — §10.
//
// The refund ledger, which is a different question from the payments list: not
// "what did this customer pay" but "what have we given back, who authorised it,
// and does it match the provider". Every row names an operator, or names nobody —
// and a refund with no operator is one the provider reported to us, which is worth
// seeing separately.
//
// There is no "issue refund" button here on purpose. A refund needs the payment it
// comes out of and the remaining refundable amount, both of which live on the
// Payments page; offering the action from a list that does not know the cap would
// mean discovering it through a 400. This page reads the ledger and opens the
// payment it came out of.
//
// There is no CSV export either, because the API has none for refunds — only
// subscriptions, payments and invoices export. A button that 404s is worse than an
// absent one.
//
// Only `succeeded` refunds are summed into the total, matching the server: a
// pending refund is a promise, not money returned.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Undo2 } from "lucide-react";
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
import { PaymentDetailDialog } from "@/components/admin/PaymentDetailDialog";
import { adminGet } from "@/lib/adminApi";
import type { RefundLedgerRow, RefundsResponse } from "@/lib/adminBillingTypes";
import { billingTone, formatDateTime, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

const STATUSES: PillOption[] = [
  { value: "all", label: "All" },
  { value: "succeeded", label: "Succeeded" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
];

export default function AdminRefunds() {
  const [rows, setRows] = useState<RefundLedgerRow[]>([]);
  const [data, setData] = useState<RefundsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [openPaymentId, setOpenPaymentId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (status !== "all") params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await adminGet<RefundsResponse>(`/refunds?${params.toString()}`);
      setRows(res.refunds);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load refunds");
    } finally {
      setLoading(false);
    }
  }, [query, status, from, to, page]);

  useEffect(() => {
    load();
  }, [load]);

  const onPage = useMemo(
    () => ({
      byProvider: rows.filter((r) => !r.admin_id).length,
      full: rows.filter(
        (r) => r.payment_amount_cents !== null && r.amount_cents >= r.payment_amount_cents,
      ).length,
    }),
    [rows],
  );

  /** A refund smaller than the charge is partial; the proportion is the useful read. */
  const share = (row: RefundLedgerRow): string | null => {
    if (!row.payment_amount_cents || row.payment_amount_cents <= 0) return null;
    if (row.amount_cents >= row.payment_amount_cents) return "full";
    return `${Math.round((row.amount_cents / row.payment_amount_cents) * 100)}% of the charge`;
  };

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Money given back, with the operator who authorised it and the charge it came out of. Issue a refund from the payment itself, where the remaining refundable amount is known."
        icon={Undo2}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        }
      />

      <MetricStrip>
        <Metric
          label="Refunded"
          value={data?.totals.refunded_label ?? "—"}
          tone="warning"
          hint="Succeeded refunds in this filter"
          loading={loading}
        />
        <Metric label="Refunds" value={data?.total ?? 0} hint="Matching the current filter" loading={loading} />
        <Metric
          label="Full reversals"
          value={onPage.full}
          hint="On this page — the whole charge went back"
          loading={loading}
        />
        <Metric
          label="Not operator-issued"
          value={onPage.byProvider}
          tone={onPage.byProvider > 0 ? "warning" : "neutral"}
          hint="On this page — reported by the provider, not raised here"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search refund id, payment id, provider reference, reason or owner email…"
        />
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <FilterPills options={STATUSES} value={status} onChange={setStatus} />
          <div className="flex items-end gap-2">
            <Field label="Raised from">
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
          message="No refunds match these filters."
          hint={
            query || status !== "all" || from || to
              ? "Clear the search or widen the date range."
              : "Nothing has been refunded. Refunds are raised from a payment on the Payments page."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                onClick={() => setOpenPaymentId(row.payment_id)}
                className="press cursor-pointer rounded-2xl border border-border/60 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <AccountCell
                    workspaceName={row.workspace_name}
                    email={row.user_email}
                    userId={row.user_id}
                  />
                  <span className="shrink-0 font-bold tabular-nums text-warning">
                    −{row.amount_label}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                  <ToneBadge label={humanize(row.provider)} />
                  {share(row) === "full" && <ToneBadge label="Full reversal" tone="warning" />}
                  {!row.admin_id && <ToneBadge label="From the provider" tone="neutral" />}
                </div>
                {row.reason && <p className="mt-2 text-xs text-muted-foreground">{row.reason}</p>}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {formatDateTime(row.created_at)}
                  {row.admin_email ? ` · ${row.admin_email}` : ""}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Refunded</th>
                  <th className="px-4 py-3">Of the charge</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Authorised by</th>
                  <th className="px-4 py-3">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenPaymentId(row.payment_id)}
                    className="cursor-pointer hover:bg-secondary/30"
                    title="Open the payment this came out of"
                  >
                    <td className="max-w-[220px] px-4 py-3">
                      <AccountCell
                        workspaceName={row.workspace_name}
                        email={row.user_email}
                        userId={row.user_id}
                      />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-warning">
                      −{row.amount_label}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {share(row) === "full" ? (
                        <span className="font-semibold text-warning">Full reversal</span>
                      ) : (
                        share(row) ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="block">{humanize(row.provider)}</span>
                      {row.provider_ref && (
                        <span
                          className="mt-0.5 block max-w-[140px] truncate font-mono text-[11px] text-muted-foreground"
                          title={row.provider_ref}
                        >
                          {row.provider_ref}
                        </span>
                      )}
                    </td>
                    <td className="max-w-[240px] px-4 py-3 text-muted-foreground">
                      <span className="block truncate" title={row.reason ?? ""}>
                        {row.reason || "—"}
                      </span>
                    </td>
                    <td className="max-w-[180px] px-4 py-3">
                      {row.admin_email ? (
                        <span className="block truncate text-xs">{row.admin_email}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">the provider</span>
                      )}
                    </td>
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
            noun="refunds"
            onPage={setPage}
          />
        </>
      )}

      <PaymentDetailDialog paymentId={openPaymentId} onClose={() => setOpenPaymentId(null)} />
    </>
  );
}
