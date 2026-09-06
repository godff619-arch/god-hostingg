// The Billing tab on the admin user detail page — §58.
//
// Billing follows workspace *ownership*, not membership, so one account can carry
// several subscriptions and this tab lists each one rather than pretending there is
// a single "plan" on the user row. §37's split is shown as it is stored: the plan the
// account is sold, and the plan it is actually entitled to right now. When those two
// disagree the row says so — that divergence is the whole reason the columns are
// separate, and it is the first thing support needs to see.
//
// Cards are masked metadata (`Visa •••• 7411`). There is no field here for a card
// number or a CVV because there is nowhere in the database for one to come from, and
// the API states that refusal itself in `never_stored` — printed at the bottom of the
// card list rather than assumed.
//
// The tab is read-only on purpose. Refunding needs the remaining refundable amount
// and voiding needs an unpaid invoice; both caps live on the pages that own them, so
// a row here opens that page's own dialog instead of offering a shortcut that would
// be discovered through a 400.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CreditCard, Loader2, ShieldCheck, TriangleAlert, Wallet } from "lucide-react";
import {
  DetailRow,
  ListEmpty,
  ListError,
  Metric,
  MetricStrip,
  ToneBadge,
} from "@/components/admin/AdminList";
import { InvoiceDetailDialog } from "@/components/admin/InvoiceDetailDialog";
import { PaymentDetailDialog } from "@/components/admin/PaymentDetailDialog";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet } from "@/lib/adminApi";
import type { UserBillingResponse } from "@/lib/adminBillingTypes";
import { billingTone, formatDate, formatDateTime, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** A titled block. Mirrors the card shell the billing pages use, at tab scale. */
function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

const TH = "px-3 py-2.5 font-semibold";const THEAD =
  "border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

function Wrap({ children, min = 640 }: { children: ReactNode; min?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" style={{ minWidth: `${min}px` }}>
          {children}
        </table>
      </div>
    </div>
  );
}

/**
 * Event names are their own vocabulary — `payment_failed` is not a status, so it is
 * not in the shared status table. Kept local rather than widening that table with
 * words no status column ever holds.
 */
function eventTone(event: string): "success" | "warning" | "danger" | "neutral" {
  if (event === "activated" || event === "renewed" || event === "upgraded" || event === "reactivated") {
    return "success";
  }
  if (event === "payment_failed" || event === "expired") return "danger";
  if (event === "downgraded" || event === "manual_override" || event === "refunded") return "warning";
  return "neutral";
}

export function UserBillingTab({ userId }: { userId: string }) {
  const { can } = useAdminMe();
  const [data, setData] = useState<UserBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openPayment, setOpenPayment] = useState<string | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<UserBillingResponse>(`/users/${userId}/billing`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) return <ListError message={error} onRetry={load} />;
  if (!data) return null;

  // An account with no workspace of its own has nothing to bill — it is a member of
  // someone else's, and that owner's tab is where the money is.
  if (data.workspaces.length === 0) {
    return (
      <ListEmpty
        message="This account owns no workspace, so it has nothing billable."
        hint="Billing follows workspace ownership. If they are a member of someone else's workspace, the subscription sits on that owner."
      />
    );
  }

  const { credit, payment_methods, payments, invoices, events, open_checkouts } = data;
  const cardsWithNoDefault = payment_methods.length > 0 && !payment_methods.some((c) => c.is_default);

  return (
    <div className="space-y-4">
      <MetricStrip>
        <Metric
          label="Credit balance"
          value={credit.balance_label}
          tone={credit.balance_cents > 0 ? "success" : "neutral"}
          hint="Spendable wallet money, not revenue"
        />
        <Metric
          label="Workspaces owned"
          value={data.workspaces.length}
          hint="Each one is billed separately"
        />
        <Metric
          label="Cards on file"
          value={payment_methods.length}
          hint="Masked metadata — no number is stored"
        />
        <Metric
          label="Open checkouts"
          value={open_checkouts.length}
          tone={open_checkouts.length > 0 ? "warning" : "neutral"}
          hint={
            open_checkouts.length > 0
              ? "Clicked upgrade and has not come back"
              : "Nothing waiting on the provider"
          }
        />
      </MetricStrip>

      {open_checkouts.length > 0 && (
        <section className="rounded-2xl border border-warning-border bg-warning-surface p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-warning">
            <TriangleAlert className="h-4 w-4" />
            {open_checkouts.length} checkout session(s) still open
          </h3>
          <p className="mt-1 text-xs text-warning">
            The plan is waiting on the provider, not on us. This is the usual answer to “I paid
            and nothing happened” — the payment never completed, so no subscription was activated.
          </p>
          <ul className="mt-3 space-y-1.5">
            {open_checkouts.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2 text-xs"
              >
                <span className="font-medium">{c.plan_key ?? "unknown plan"}</span>
                <span className="tabular-nums">{c.amount_label}</span>
                <span className="text-muted-foreground">{humanize(c.provider)}</span>
                <span className="tabular-nums text-muted-foreground">
                  started {formatDateTime(c.created_at)}
                  {c.expires_at ? ` · expires ${formatDateTime(c.expires_at)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={cn("grid gap-4", data.workspaces.length > 1 && "lg:grid-cols-2")}>
        {data.workspaces.map((w) => (
          <Panel
            key={w.workspace_id ?? w.subscription_id ?? w.plan_key}
            title={w.workspace_name || "Unnamed workspace"}
            hint={w.live ? "Subscription is live" : "No live subscription"}
            action={
              <Link
                to="/admin/subscriptions"
                className="text-xs font-medium text-brand hover:underline"
              >
                Manage
              </Link>
            }
          >
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <ToneBadge label={humanize(w.subscription_status)} tone={billingTone(w.subscription_status)} />
              <ToneBadge label={`Payment: ${humanize(w.payment_status)}`} tone={billingTone(w.payment_status)} />
              <ToneBadge label={humanize(w.billing_provider)} />
              {w.manual_override && <ToneBadge label="Manual override" tone="warning" />}
              {w.cancel_at_period_end && <ToneBadge label="Cancels at period end" tone="warning" />}
              {!w.entitlement_matches_plan && <ToneBadge label="Entitlement differs" tone="danger" />}
            </div>

            <DetailRow label="Plan sold">{w.plan_name || w.plan_key}</DetailRow>
            <DetailRow label="Entitled to">
              <span className={cn(!w.entitlement_matches_plan && "font-semibold text-warning")}>
                {w.effective_plan_name || w.effective_plan}
              </span>
            </DetailRow>
            <DetailRow label="Current period">
              {w.current_period_start || w.current_period_end
                ? `${formatDate(w.current_period_start)} → ${formatDate(w.current_period_end)}`
                : "—"}
            </DetailRow>
            <DetailRow label="Cards on this workspace">
              <span className="tabular-nums">{w.card_count}</span>
            </DetailRow>
            {w.manual_override && (
              <DetailRow label="Override">
                <span className="block text-xs">
                  {w.manual_override_reason || "No reason recorded"}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {w.manual_override_by ?? "unknown operator"} · {formatDateTime(w.manual_override_at)}
                </span>
              </DetailRow>
            )}
            {!w.entitlement_matches_plan && (
              <p className="mt-2 text-[11px] text-warning">
                The account is sold {w.plan_name || w.plan_key} but the platform is enforcing{" "}
                {w.effective_plan_name || w.effective_plan}. A lapsed period or a failed payment
                does that; the entitlement is what the quotas actually use.
              </p>
            )}
          </Panel>
        ))}
      </div>

      <Panel
        title="Payment methods"
        hint="Masked metadata the provider gave us back. The customer adds and removes these from their own billing page."
      >
        {payment_methods.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No card on file. An account can still be on a paid plan — a manual override or credit
            does not need one.
          </p>
        ) : (
          <ul className="space-y-2">
            {payment_methods.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{c.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.billing_name || "No cardholder name"} · {humanize(c.funding)} {humanize(c.type)}
                      {c.billing_country ? ` · ${c.billing_country}` : ""}
                    </span>
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {c.is_default && <ToneBadge label="Default" tone="success" />}
                  <ToneBadge label={humanize(c.status)} tone={billingTone(c.status)} />
                  <ToneBadge label={`Expires ${c.expiry_label}`} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {cardsWithNoDefault && (
          <p className="mt-3 text-xs text-warning">
            None of these is marked default, so a renewal has no card to charge.
          </p>
        )}

        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          Never stored, anywhere:
          {data.never_stored.map((field) => (
            <code key={field} className="rounded bg-secondary px-1.5 py-0.5 font-mono">
              {field}
            </code>
          ))}
        </p>
      </Panel>

      <Panel
        title="Payments"
        hint="The 50 most recent charges across every workspace this account owns. Open one for the provider payload and its refunds."
        action={
          <Link to="/admin/payments" className="text-xs font-medium text-brand hover:underline">
            All payments
          </Link>
        }
      >
        {payments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing has ever been charged to this account.
          </p>
        ) : (
          <Wrap min={720}>
            <thead>
              <tr className={THEAD}>
                <th className={TH}>Amount</th>
                <th className={TH}>Status</th>
                <th className={TH}>Kind</th>
                <th className={TH}>Plan</th>
                <th className={TH}>Refunded</th>
                <th className={TH}>When</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setOpenPayment(p.id)}
                  className="cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-secondary/30"
                  title="Open this payment"
                >
                  <td className="px-3 py-2.5 font-semibold tabular-nums">{p.amount_label}</td>
                  <td className="px-3 py-2.5">
                    <ToneBadge label={humanize(p.status)} tone={billingTone(p.status)} />
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{humanize(p.kind)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{p.plan_key ?? "—"}</td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                    {p.refunded_cents > 0 ? (
                      <span className="font-semibold text-warning">−{p.refunded_label}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                    {formatDateTime(p.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Wrap>
        )}
        {payments.some((p) => p.failure_code) && (
          <p className="mt-3 text-xs text-muted-foreground">
            A failed charge keeps its provider failure code; open the row to read it.
          </p>
        )}
      </Panel>

      <Panel
        title="Invoices"
        hint="Billing documents and what is owed. Voiding, marking paid and re-sending happen inside the invoice, where the eligibility is known."
        action={
          <Link to="/admin/invoices" className="text-xs font-medium text-brand hover:underline">
            All invoices
          </Link>
        }
      >
        {invoices.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No invoice has been issued to this account.
          </p>
        ) : (
          <Wrap min={720}>
            <thead>
              <tr className={THEAD}>
                <th className={TH}>Number</th>
                <th className={TH}>Amount</th>
                <th className={TH}>Status</th>
                <th className={TH}>Period</th>
                <th className={TH}>Issued</th>
                <th className={TH}>Paid</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr
                  key={inv.id}
                  onClick={() => setOpenInvoice(inv.id)}
                  className="cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-secondary/30"
                  title="Open this invoice"
                >
                  <td className="px-3 py-2.5 font-mono text-xs font-semibold">{inv.number}</td>
                  <td className="px-3 py-2.5 font-semibold tabular-nums">{inv.amount_label}</td>
                  <td className="px-3 py-2.5">
                    <ToneBadge label={humanize(inv.status)} tone={billingTone(inv.status)} />
                  </td>
                  <td className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
                    {inv.period_start || inv.period_end
                      ? `${formatDate(inv.period_start)} → ${formatDate(inv.period_end)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                    {formatDate(inv.issued_at)}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                    {formatDate(inv.paid_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Wrap>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Credit movements"
          hint="Positive is granted, negative is taken back. Every row names its reason."
          action={
            <Link to="/admin/credits" className="text-xs font-medium text-brand hover:underline">
              Wallet ledger
            </Link>
          }
        >
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Balance</span>
            <span className="ml-auto text-sm font-bold tabular-nums">{credit.balance_label}</span>
          </div>
          {credit.transactions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No credit has ever moved on this account.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {credit.transactions.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{humanize(t.kind)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.reason || "No reason recorded"}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {formatDateTime(t.created_at)} · {t.admin_email ?? "system"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-sm font-bold tabular-nums",
                      t.amount_cents >= 0 ? "text-success" : "text-warning",
                    )}
                  >
                    {t.amount_cents >= 0 ? "+" : "−"}
                    {t.amount_label.replace("-", "")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Subscription history"
          hint="Every plan change, and what caused it. `webhook` is the provider, `admin` is an operator, `system` is a period expiring on its own."
        >
          {events.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nothing has changed on this subscription yet.
            </p>
          ) : (
            <ol className="divide-y divide-border/40">
              {events.map((e) => (
                <li key={e.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ToneBadge label={humanize(e.event)} tone={eventTone(e.event)} />
                    <ToneBadge label={humanize(e.source)} />
                    {e.from_plan && e.to_plan && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {e.from_plan} → {e.to_plan}
                      </span>
                    )}
                  </div>
                  {e.reason && <p className="mt-1 text-xs text-muted-foreground">{e.reason}</p>}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatDateTime(e.created_at)}
                    {e.payment_id ? " · settled by a payment" : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      <PaymentDetailDialog paymentId={openPayment} onClose={() => setOpenPayment(null)} />
      <InvoiceDetailDialog
        invoiceId={openInvoice}
        onClose={() => setOpenInvoice(null)}
        onDone={load}
        mayManage={can("invoices.manage")}
      />
    </div>
  );
}
