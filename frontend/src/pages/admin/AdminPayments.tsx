// Admin Payments (/admin/payments) — §10, §35, §44.
//
// The money that actually arrived. Two things make this page different from a
// generic table:
//
//   • The four figures at the top are SQL aggregates over the *whole filtered
//     set*, not sums of the visible page (§53). A "collected" number that changes
//     when you turn the page is worse than no number.
//   • Nothing here can mark a payment succeeded. Only a signature-verified webhook
//     does that (§34). The one mutation on this page is a refund, and it is gated
//     on `refunds.manage` both here and on the server (§47).
//
// `refundable_cents` is computed server-side and is what enables the Refund
// button — the client never subtracts refunds from a charge itself, because a
// partially-refunded row would then disagree with the ledger.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, Download, Eye, RefreshCw, Undo2 } from "lucide-react";
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
import { PaymentDetailDialog } from "@/components/admin/PaymentDetailDialog";
import { RefundDialog } from "@/components/admin/RefundDialog";
import { adminDownload, adminGet } from "@/lib/adminApi";
import type { PaymentRow, PaymentsResponse } from "@/lib/adminBillingTypes";
import { billingTone, formatDateTime, humanize } from "@/lib/adminFormat";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

/** Payment.kind in the schema. Fixed vocabulary, so it is safe to hardcode. */
const KINDS: PillOption[] = [
  { value: "all", label: "Any kind" },
  { value: "subscription", label: "Subscription" },
  { value: "one_time", label: "One-off" },
  { value: "credit_topup", label: "Credit top-up" },
];

export default function AdminPayments() {
  const { can } = useAdminMe();
  const mayRefund = can("refunds.manage");

  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<PaymentsResponse["totals"] | null>(null);
  const [statusFacets, setStatusFacets] = useState<PaymentsResponse["facets"]["statuses"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<PaymentRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, kind, from, to]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (status !== "all") params.set("status", status);
    if (kind !== "all") params.set("kind", kind);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [query, status, kind, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = filterParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await adminGet<PaymentsResponse>(`/payments?${params.toString()}`);
      setRows(res.payments);
      setTotal(res.total);
      setTotals(res.totals);
      setStatusFacets(res.facets.statuses);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payments");
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
      await adminDownload(`/payments/export?${filterParams().toString()}`, "payments.csv");
      toast.success("Export downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  };

  const filtered = Boolean(query) || status !== "all" || kind !== "all" || from || to;

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every charge, refund and failure across the platform. Figures are totals for the current filter, not just this page."
        icon={Banknote}
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
          label="Collected"
          value={totals?.collected_label ?? "—"}
          tone="success"
          hint={`${totals?.succeeded_count ?? 0} settled payments`}
          loading={loading}
        />
        <Metric
          label="Refunded"
          value={totals?.refunded_label ?? "—"}
          tone={totals && totals.refunded_cents > 0 ? "warning" : "neutral"}
          hint="Returned to customers"
          loading={loading}
        />
        <Metric
          label="Net"
          value={totals?.net_label ?? "—"}
          hint="Collected less refunds"
          loading={loading}
        />
        <Metric label="Rows" value={total} hint="Matching the current filter" loading={loading} />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search payment id, provider reference, description or account…"
        />
        <FilterPills options={statusOptions} value={status} onChange={setStatus} />
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <FilterPills options={KINDS} value={kind} onChange={setKind} />
          <div className="flex items-end gap-2">
            <Field label="From">
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
          message="No payments match these filters."
          hint={
            filtered
              ? "Widen the date range or clear a filter."
              : "Payments appear here once a checkout completes and the provider webhook is verified."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden stagger-in">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <AccountCell
                    workspaceName={row.workspace_name}
                    email={row.user_email}
                    userId={row.user_id}
                  />
                  <span className="shrink-0 text-right">
                    <span className="block font-bold tabular-nums">{row.amount_label}</span>
                    {row.refunded_cents > 0 && (
                      <span className="block text-[11px] text-warning">
                        −{row.refunded_label} refunded
                      </span>
                    )}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                  <ToneBadge label={humanize(row.kind)} />
                  <span className="text-[11px] text-muted-foreground">
                    {formatDateTime(row.created_at)}
                  </span>
                </div>

                {row.failure_message && (
                  <p className="mt-2 text-xs text-danger">{row.failure_message}</p>
                )}

                <div className="mt-3 flex gap-1.5 border-t border-border/40 pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border/60"
                    onClick={() => setDetailId(row.id)}
                  >
                    <Eye className="h-3.5 w-3.5" /> Details
                  </Button>
                  {mayRefund && row.refundable_cents > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-border/60"
                      onClick={() => setRefundTarget(row)}
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Refund
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-secondary/30">
                    <td className="max-w-[240px] px-4 py-3">
                      <AccountCell
                        workspaceName={row.workspace_name}
                        email={row.user_email}
                        userId={row.user_id}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="block font-semibold tabular-nums">{row.amount_label}</span>
                      {row.refunded_cents > 0 && (
                        <span className="block text-[11px] text-warning">
                          −{row.refunded_label}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(row.status)} tone={billingTone(row.status)} />
                      {row.failure_code && (
                        <span className="mt-1 block text-[11px] text-danger" title={row.failure_message ?? ""}>
                          {row.failure_code}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {humanize(row.kind)}
                      {row.plan_key && (
                        <span className="block text-[11px]">{row.plan_key}</span>
                      )}
                    </td>
                    <td className="max-w-[180px] px-4 py-3">
                      <span className="block text-muted-foreground">{humanize(row.provider)}</span>
                      {row.provider_ref && (
                        <span className="block truncate font-mono text-[11px] text-muted-foreground/80">
                          {row.provider_ref}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDateTime(row.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Payment details"
                          aria-label="Payment details"
                          onClick={() => setDetailId(row.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {mayRefund && row.refundable_cents > 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Record a refund"
                            aria-label="Record a refund"
                            onClick={() => setRefundTarget(row)}
                          >
                            <Undo2 className="h-4 w-4" />
                          </Button>
                        )}
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
            noun="payments"
            onPage={setPage}
          />
        </>
      )}

      <PaymentDetailDialog
        paymentId={detailId}
        onClose={() => setDetailId(null)}
        onRefund={mayRefund ? setRefundTarget : undefined}
      />
      <RefundDialog
        payment={refundTarget}
        onClose={() => setRefundTarget(null)}
        onDone={load}
      />
    </>
  );
}
