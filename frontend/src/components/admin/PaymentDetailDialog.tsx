// One payment, everything the platform knows about it (§10, §35 forensics).
//
// The reason this is a dialog and not a row expansion: the useful content is the
// chain around the payment — the invoice it settled, the checkout session that
// started it, the subscription events it caused, and the raw provider payload. A
// table row cannot hold that, and support needs all four at once when answering
// "they say they paid and nothing happened".
//
// The provider payload is printed verbatim. It is the evidence; reformatting it
// into friendlier fields would mean the screen no longer shows what the provider
// actually sent.

import { useEffect, useState } from "react";
import { Loader2, Receipt, Undo2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DetailRow, ListError, ToneBadge } from "@/components/admin/AdminList";
import { adminGet } from "@/lib/adminApi";
import type { PaymentDetail, PaymentRow } from "@/lib/adminBillingTypes";
import { billingTone, formatDateTime, humanize } from "@/lib/adminFormat";

interface Props {
  paymentId: string | null;
  onClose: () => void;
  /** Opens the refund dialog for this payment. Hidden when the caller can't refund. */
  onRefund?: (payment: PaymentRow) => void;
}

export function PaymentDetailDialog({ paymentId, onClose, onRefund }: Props) {
  const [data, setData] = useState<PaymentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!paymentId) return;
    let live = true;
    setLoading(true);
    setData(null);
    setError(null);
    adminGet<PaymentDetail>(`/payments/${paymentId}`)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Could not load the payment.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [paymentId]);

  if (!paymentId) return null;
  const p = data?.payment;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-brand" /> Payment
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {paymentId}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {error && <ListError message={error} />}

        {p && (
          <div className="space-y-5">
            <section className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-1">
              <DetailRow label="Account">
                <span className="font-semibold">
                  {p.workspace_name || p.user_email || p.workspace_id || "—"}
                </span>
              </DetailRow>
              <DetailRow label="Amount">
                <span className="font-semibold tabular-nums">{p.amount_label}</span>
              </DetailRow>
              <DetailRow label="Status">
                <ToneBadge label={humanize(p.status)} tone={billingTone(p.status)} />
              </DetailRow>
              <DetailRow label="Kind">{humanize(p.kind)}</DetailRow>
              <DetailRow label="Plan bought">{p.plan_key ?? "—"}</DetailRow>
              <DetailRow label="Provider">
                {humanize(p.provider)}
                {p.provider_ref && (
                  <span className="ml-2 break-all font-mono text-xs text-muted-foreground">
                    {p.provider_ref}
                  </span>
                )}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(p.created_at)}</DetailRow>
              {p.succeeded_at && (
                <DetailRow label="Succeeded">{formatDateTime(p.succeeded_at)}</DetailRow>
              )}
              {p.failed_at && <DetailRow label="Failed">{formatDateTime(p.failed_at)}</DetailRow>}
              {p.failure_message && (
                <DetailRow label="Failure">
                  <span className="text-danger">
                    {p.failure_message}
                    {p.failure_code ? ` (${p.failure_code})` : ""}
                  </span>
                </DetailRow>
              )}
              {p.description && <DetailRow label="Description">{p.description}</DetailRow>}
            </section>

            {p.refunds.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Refunds · {p.refunded_label}
                </h3>
                <ul className="space-y-1.5">
                  {p.refunds.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs"
                    >
                      <span className="font-semibold tabular-nums">{r.amount_label}</span>
                      <ToneBadge label={humanize(r.status)} tone={billingTone(r.status)} />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.reason ?? ""}>
                        {r.reason || "no reason recorded"}
                      </span>
                      <span className="text-muted-foreground">{formatDateTime(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data?.invoice && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Invoice
                </h3>
                <div className="rounded-xl border border-border/60 px-3 py-1">
                  <DetailRow label="Number">
                    <span className="font-mono text-xs">{data.invoice.number}</span>
                  </DetailRow>
                  <DetailRow label="Total">
                    <span className="tabular-nums">{data.invoice.amount_label}</span>
                  </DetailRow>
                  <DetailRow label="Status">
                    <ToneBadge
                      label={humanize(data.invoice.status)}
                      tone={billingTone(data.invoice.status)}
                    />
                  </DetailRow>
                </div>
              </section>
            )}

            {data?.checkout_session && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Checkout session
                </h3>
                <div className="rounded-xl border border-border/60 px-3 py-1">
                  <DetailRow label="Status">
                    <ToneBadge
                      label={humanize(data.checkout_session.status)}
                      tone={billingTone(data.checkout_session.status)}
                    />
                  </DetailRow>
                  <DetailRow label="Started">
                    {formatDateTime(data.checkout_session.created_at)}
                  </DetailRow>
                  <DetailRow label="Completed">
                    {data.checkout_session.completed_at
                      ? formatDateTime(data.checkout_session.completed_at)
                      : "never"}
                  </DetailRow>
                </div>
              </section>
            )}

            {data && data.subscription_events.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  What this payment changed
                </h3>
                <ul className="space-y-1.5">
                  {data.subscription_events.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs"
                    >
                      <span className="font-semibold">{humanize(e.event)}</span>
                      {e.from_plan && e.to_plan && (
                        <span className="text-muted-foreground">
                          {e.from_plan} → {e.to_plan}
                        </span>
                      )}
                      <span className="ml-auto text-muted-foreground">
                        {formatDateTime(e.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data?.provider_event ? (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Verified provider payload
                </h3>
                <pre className="max-h-64 overflow-auto rounded-xl border border-border/60 bg-secondary/30 p-3 text-[11px] leading-relaxed">
                  {JSON.stringify(data.provider_event, null, 2)}
                </pre>
              </section>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {p && onRefund && p.refundable_cents > 0 && (
            <Button
              variant="outline"
              className="border-border/60"
              onClick={() => {
                onRefund(p);
                onClose();
              }}
            >
              <Undo2 className="h-4 w-4" /> Refund
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
