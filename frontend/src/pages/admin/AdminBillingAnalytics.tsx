// Admin Billing Analytics (/admin/billing-analytics) — §44.
//
// Every figure is computed from rows on the server, and the page is written so a
// reader can tell which kind of number they are looking at:
//
//   • Recurring (MRR/ARR) is a *forecast* built from live entitlements and plan
//     prices. Comped accounts are excluded and reported beside it, because a Pro
//     account an operator granted by hand produces no revenue (§59).
//   • Collected is *money that arrived* — Payment rows net of refunds, not plan
//     prices, because a discounted or credit-funded activation charged less than
//     list price.
//
// The chart is plain divs. A charting dependency for twelve bars would be the
// heaviest thing on the page, and the flat design law (§28) rules out the
// gradients and glow such libraries default to.

import { useCallback, useEffect, useState } from "react";
import { ChartLine, RefreshCw, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import {
  AccountCell,
  ListError,
  Metric,
  MetricStrip,
  type PillOption,
  FilterPills,
} from "@/components/admin/AdminList";
import { adminGet } from "@/lib/adminApi";
import type { BillingAnalytics } from "@/lib/adminBillingTypes";
import { humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const RANGES: PillOption[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
];

/** 0.0345 → `3.5%`. One decimal: two is false precision on a small account base. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** `2026-09` → `Sep`, with the year appended each January so the axis stays readable. */
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const name = new Date(y, (m ?? 1) - 1, 1).toLocaleString(undefined, { month: "short" });
  return m === 1 ? `${name} ${String(y).slice(-2)}` : name;
}

export default function AdminBillingAnalytics() {
  const [data, setData] = useState<BillingAnalytics | null>(null);
  const [days, setDays] = useState("30");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<BillingAnalytics>(`/billing/analytics?days=${days}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compute billing analytics");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const peak = Math.max(1, ...(data?.revenue_by_month ?? []).map((m) => m.revenue_cents));
  const planTotal = (data?.plan_distribution ?? []).reduce((s, p) => s + p.count, 0) || 1;

  return (
    <>
      <PageHeader
        title="Billing analytics"
        description="Recurring revenue, what was actually collected, and the health of the funnel. Every number is derived from rows — none of it is a placeholder."
        icon={ChartLine}
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

      <div className="mb-4">
        <FilterPills options={RANGES} value={days} onChange={setDays} />
      </div>

      {error && <ListError message={error} onRetry={load} />}

      <MetricStrip>
        <Metric
          label="MRR"
          value={data?.recurring.mrr_label ?? "—"}
          tone="success"
          hint={`${data?.recurring.paying_accounts ?? 0} paying account(s), comped excluded`}
          loading={loading}
        />
        <Metric
          label="ARR"
          value={data?.recurring.arr_label ?? "—"}
          hint="MRR × 12 — a forecast, not collected money"
          loading={loading}
        />
        <Metric
          label="Collected this month"
          value={data?.collected.month_label ?? "—"}
          hint={`${data?.collected.today_label ?? "—"} today, net of refunds`}
          loading={loading}
        />
        <Metric
          label="Comped value"
          value={data?.recurring.comped_mrr_label ?? "—"}
          tone={data && data.recurring.comped_accounts > 0 ? "warning" : "neutral"}
          hint={`${data?.recurring.comped_accounts ?? 0} account(s) granted by hand — never inside MRR`}
          loading={loading}
        />
      </MetricStrip>

      <MetricStrip>
        <Metric
          label="Churn"
          value={data ? percent(data.health.churn_rate) : "—"}
          tone={data && data.health.churn_rate > 0.05 ? "danger" : "neutral"}
          hint={`${data?.health.churned_in_range ?? 0} cancelled in the last ${days} days`}
          loading={loading}
        />
        <Metric
          label="Conversion"
          value={data ? percent(data.health.conversion_rate) : "—"}
          hint={`${data?.recurring.paying_accounts ?? 0} of ${data?.health.total_accounts ?? 0} accounts pay`}
          loading={loading}
        />
        <Metric
          label="Payment success"
          value={data ? percent(data.health.payment_success_rate) : "—"}
          tone={data && data.health.payment_success_rate < 0.9 ? "warning" : "success"}
          hint={`${data?.health.payments_attempted ?? 0} attempted, ${data?.health.failed_payments ?? 0} failed`}
          loading={loading}
        />
        <Metric
          label="Credit liability"
          value={data?.health.credit_liability_label ?? "—"}
          tone="warning"
          hint="Unspent credit across every wallet"
          loading={loading}
        />
      </MetricStrip>

      <section className="mb-6 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            Collected by month
          </h2>
          <p className="text-xs text-muted-foreground">
            Twelve months, net of refunds. Bars are relative to the best month.
          </p>
        </header>

        {loading ? (
          <div className="h-44 animate-pulse rounded-xl bg-secondary/40" />
        ) : !data || data.revenue_by_month.every((m) => m.revenue_cents === 0) ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No settled payments in the last twelve months.
          </p>
        ) : (
          <div className="flex h-44 items-end gap-1.5 sm:gap-2">
            {data.revenue_by_month.map((m) => {
              const pct = Math.round((m.revenue_cents / peak) * 100);
              return (
                <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className={cn(
                        "w-full rounded-t-md",
                        m.revenue_cents > 0 ? "bg-brand" : "bg-border/60",
                      )}
                      style={{ height: `${Math.max(pct, m.revenue_cents > 0 ? 3 : 1)}%` }}
                      title={`${monthLabel(m.month)}: ${m.payments} payment(s)`}
                    />
                  </div>
                  <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                    {monthLabel(m.month)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold">Accounts by plan</h2>
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-secondary/40" />
              ))}
            </div>
          ) : !data || data.plan_distribution.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No accounts yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {data.plan_distribution.map((p) => (
                <li key={p.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {p.count} · {Math.round((p.count / planTotal) * 100)}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        p.monthly_price_cents > 0 ? "bg-brand" : "bg-border",
                      )}
                      style={{ width: `${Math.max((p.count / planTotal) * 100, 1)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Counted by the plan each account is <em>entitled</em> to, which is what the platform
            actually enforces — not the plan on the last invoice.
          </p>
        </section>

        <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold">Payment attempts</h2>
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-secondary/40" />
              ))}
            </div>
          ) : !data || data.payment_statuses.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No payments in the last {days} days.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {data.payment_statuses.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{humanize(s.key)}</span>
                  <span className="tabular-nums font-semibold">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-2">
              <span className="block text-muted-foreground">Pending now</span>
              <span className="font-semibold tabular-nums">
                {data?.health.pending_payments ?? 0}
              </span>
            </div>
            <div className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-2">
              <span className="block text-muted-foreground">Open checkouts</span>
              <span className="font-semibold tabular-nums">{data?.health.open_checkouts ?? 0}</span>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            An open checkout is a customer who clicked upgrade and has not come back. It is the
            usual answer to “I paid and nothing happened”.
          </p>
        </section>
      </div>

      {data && data.top_accounts.length > 0 && (
        <section className="mt-4 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold">Highest-value accounts</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Net of refunds, over the last {days} days. Who to call first when something breaks.
          </p>
          <ul className="divide-y divide-border/40">
            {data.top_accounts.map((a, i) => (
              <li
                key={a.workspace_id ?? `${a.user_id}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-secondary text-[11px] font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <AccountCell
                    workspaceName={a.workspace_name}
                    email={a.user_email}
                    userId={a.user_id}
                  />
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{a.revenue_label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
