// Record a refund against a payment (§10, §47 `refunds.manage`).
//
// The wording in here matters as much as the fields. This endpoint does not call
// the payment provider — the credentials that move money live in the provider
// dashboard, and a half-finished remote call would leave our ledger claiming a
// refund that never landed. So the dialog says plainly that it records a refund
// the operator is issuing at the provider, and offers `provider_ref` to tie the
// two together.
//
// Three guards, each mirroring a server rule:
//   • The amount is capped at `refundable_cents`; the server caps it again, so no
//     sequence of clicks can over-refund.
//   • A reason is mandatory (400 REASON_REQUIRED).
//   • "Revoke the plan" is off by default and labelled with what it does — a
//     refund and a downgrade are two decisions, and merging them silently is how
//     a customer loses access to an app they are still paying for.

import { useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DetailRow, Field } from "@/components/admin/AdminList";
import { adminSend } from "@/lib/adminApi";
import type { PaymentRow } from "@/lib/adminBillingTypes";
import { centsToInput, formatDateTime, inputToCents } from "@/lib/adminFormat";

interface Props {
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
}

export function RefundDialog({ payment, onClose, onDone }: Props) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [providerRef, setProviderRef] = useState("");
  const [revokePlan, setRevokePlan] = useState(false);
  const [saving, setSaving] = useState(false);

  // Prefill with the full refundable remainder — the common case is a full
  // refund, and typing an amount by hand is how a digit gets dropped.
  useEffect(() => {
    if (!payment) return;
    setAmount(centsToInput(payment.refundable_cents));
    setReason("");
    setProviderRef("");
    setRevokePlan(false);
  }, [payment]);

  if (!payment) return null;

  const requested = inputToCents(amount);
  const overCap = requested !== null && requested > payment.refundable_cents;
  const invalidAmount = requested === null || requested <= 0 || overCap;

  const submit = async () => {
    if (!reason.trim()) {
      toast.error("A reason is required — it goes in the audit log.");
      return;
    }
    if (invalidAmount) {
      toast.error(
        overCap
          ? `Only ${payment.amount_label} was charged; ${centsToInput(payment.refundable_cents)} is still refundable.`
          : "Enter an amount greater than zero.",
      );
      return;
    }
    setSaving(true);
    try {
      const res = await adminSend<{ message?: string }>("/refunds", "POST", {
        payment_id: payment.id,
        amount_cents: requested,
        reason,
        provider_ref: providerRef.trim() || null,
        revoke_plan: revokePlan,
      });
      toast.success(res.message || "Refund recorded.");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The refund was not recorded.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-surface">
            <Undo2 className="h-6 w-6 text-warning" />
          </div>
          <DialogTitle className="text-center">Record a refund</DialogTitle>
          <DialogDescription className="text-center">
            {payment.workspace_name || payment.user_email || payment.workspace_id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-1">
            <DetailRow label="Charged">
              <span className="font-semibold tabular-nums">{payment.amount_label}</span>
            </DetailRow>
            <DetailRow label="Already refunded">
              <span className="tabular-nums">{payment.refunded_label ?? "—"}</span>
            </DetailRow>
            <DetailRow label="Still refundable">
              <span className="font-semibold tabular-nums text-warning">
                {centsToInput(payment.refundable_cents)} {payment.currency.toUpperCase()}
              </span>
            </DetailRow>
            <DetailRow label="Paid at">
              {formatDateTime(payment.succeeded_at ?? payment.created_at)}
            </DetailRow>
            {payment.provider_ref && (
              <DetailRow label={`${payment.provider} id`}>
                <span className="break-all font-mono text-xs">{payment.provider_ref}</span>
              </DetailRow>
            )}
          </div>

          <Field
            label={`Amount to refund (${payment.currency.toUpperCase()})`}
            hint={`Capped at ${centsToInput(payment.refundable_cents)}. Partial refunds are allowed and can be repeated.`}
          >
            <Input
              type="number"
              step="0.01"
              min="0.01"
              max={centsToInput(payment.refundable_cents)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

          <Field
            label="Provider refund id (optional)"
            hint="Paste the id from the provider dashboard so this row can be reconciled against theirs."
          >
            <Input
              value={providerRef}
              onChange={(e) => setProviderRef(e.target.value)}
              placeholder="re_1Qf…"
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={revokePlan}
              onChange={(e) => setRevokePlan(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--danger))]"
            />
            <span className="text-xs">
              <span className="block font-semibold text-foreground">
                Also move the account back to Free
              </span>
              <span className="block text-muted-foreground">
                Off by default. Leave it off to refund the money but let the paid period
                run out as scheduled; switch it on when the refund is a reversal of the
                purchase itself.
              </span>
            </span>
          </label>

          <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning">
            This records the refund in the ledger and the audit log. It does not call{" "}
            {payment.provider} — issue the refund there as well, or the two will disagree.
          </p>

          <Field
            label="Reason (required)"
            hint="Stored on the refund row and in the audit log (§24)."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Duplicate charge — customer was billed twice on ticket #4182."
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={saving || !reason.trim() || invalidAmount}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Record refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
