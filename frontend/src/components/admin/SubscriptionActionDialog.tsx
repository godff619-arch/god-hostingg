// The four subscription actions (§8, §35, §36, §59) in one dialog.
//
// One component rather than four because the shape is identical every time: state
// the consequence in words, take a mandatory reason, send it, report what the
// server actually did. It is shared by the Subscriptions list and the §58 Billing
// tab on a user, so an operator gets the same confirmation wherever they act.
//
// Two rules are enforced here as well as on the server:
//   • The reason is required. The API answers REASON_REQUIRED without one, and the
//     audit row is worthless without it (§24).
//   • A manual plan grant is never described as a payment. §59: the override
//     writes `payment_status = 'none'`, and the copy in here says so.

import { useEffect, useState } from "react";
import { AlertTriangle, Gift, Loader2, RotateCcw, XCircle } from "lucide-react";
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
import { Field, SelectBox } from "@/components/admin/AdminList";
import { adminSend } from "@/lib/adminApi";
import type { Plan } from "@/lib/adminTypes";
import type { SubscriptionRow } from "@/lib/adminBillingTypes";
import { formatDate } from "@/lib/adminFormat";

export type SubscriptionAction = "override" | "cancel" | "resume" | "extend";

interface Props {
  action: SubscriptionAction | null;
  row: Pick<SubscriptionRow, "workspace_id" | "workspace_name" | "user_email" | "plan_key" | "current_period_end" | "cancel_at_period_end"> | null;
  plans: Plan[];
  onClose: () => void;
  /** Called after a successful mutation so the caller can refetch. */
  onDone: () => void;
}

const COPY: Record<SubscriptionAction, { title: string; verb: string; icon: typeof Gift }> = {
  override: { title: "Change plan by hand", verb: "Apply change", icon: Gift },
  cancel: { title: "Cancel subscription", verb: "Cancel subscription", icon: XCircle },
  resume: { title: "Withdraw cancellation", verb: "Keep subscription", icon: RotateCcw },
  extend: { title: "Extend the paid period", verb: "Extend period", icon: AlertTriangle },
};

export function SubscriptionActionDialog({ action, row, plans, onClose, onDone }: Props) {
  const [reason, setReason] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [days, setDays] = useState("30");
  const [immediate, setImmediate] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset on every open so a reason typed for one account can never be submitted
  // against the next one.
  useEffect(() => {
    if (!action || !row) return;
    setReason("");
    setPlanKey(row.plan_key ?? "");
    setExpiresAt("");
    setDays("30");
    setImmediate(false);
  }, [action, row]);

  if (!action || !row?.workspace_id) return null;
  const { title, verb, icon: Icon } = COPY[action];
  const target = row.workspace_name || row.user_email || row.workspace_id;
  const selectedPlan = plans.find((p) => p.key === planKey);
  const grantsPaidPlan = Boolean(selectedPlan && selectedPlan.price_cents > 0);

  const submit = async () => {
    if (!reason.trim()) {
      toast.error("A reason is required — it goes in the audit log.");
      return;
    }
    setSaving(true);
    try {
      const base = `/subscriptions/${row.workspace_id}`;
      let res: { message?: string };
      if (action === "override") {
        if (!planKey) {
          toast.error("Pick a plan.");
          setSaving(false);
          return;
        }
        res = await adminSend(`${base}/override`, "POST", {
          plan_key: planKey,
          reason,
          confirm: true,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        });
      } else if (action === "cancel") {
        res = await adminSend(`${base}/cancel`, "POST", { reason, immediate });
      } else if (action === "resume") {
        res = await adminSend(`${base}/resume`, "POST", { reason });
      } else {
        res = await adminSend(`${base}/extend`, "POST", { reason, days: Number(days) });
      }
      toast.success(res.message || "Done.");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The change was not applied.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-surface">
            <Icon className="h-6 w-6 text-warning" />
          </div>
          <DialogTitle className="text-center">{title}</DialogTitle>
          <DialogDescription className="text-center">
            <span className="font-semibold text-foreground">{target}</span>
            {row.user_email && row.workspace_name ? ` · ${row.user_email}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {action === "override" && (
            <>
              <Field label="Plan">
                <SelectBox value={planKey} onChange={setPlanKey}>
                  <option value="">Select a plan…</option>
                  {plans.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} · {(p.price_cents / 100).toFixed(2)} {p.currency}/{p.interval}
                    </option>
                  ))}
                </SelectBox>
              </Field>
              <Field
                label="Expires (optional)"
                hint="Leave empty for no end date. Must be in the future."
              >
                <Input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </Field>
              {grantsPaidPlan && (
                <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning">
                  This grants a paid plan without taking a payment. It is recorded as a
                  manual override, no Payment row is created, and revenue reports will
                  count it as comped rather than earned.
                </p>
              )}
            </>
          )}

          {action === "cancel" && (
            <>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={immediate}
                  onChange={(e) => setImmediate(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--danger)]"
                />
                <span className="text-xs">
                  <span className="block font-semibold text-foreground">Cut access off now</span>
                  <span className="block text-muted-foreground">
                    Off by default: the customer has paid until{" "}
                    {formatDate(row.current_period_end)}, so the plan normally stays live
                    until then and simply does not renew.
                  </span>
                </span>
              </label>
            </>
          )}

          {action === "resume" && (
            <p className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
              The pending cancellation is withdrawn and the subscription renews as normal.
              This only works while the paid period is still open — a period that has
              already ended needs a payment or a manual override.
            </p>
          )}

          {action === "extend" && (
            <Field label="Extend by (days)" hint="1–730 days, counted from the later of now and the current period end.">
              <Input
                type="number"
                min={1}
                max={730}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
          )}

          <Field
            label="Reason (required)"
            hint="Stored on the subscription event and in the audit log (§24). Write what you would want to read six months from now."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Refunded duplicate charge on ticket #4182 and moved the account back to Free."
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Keep as is
          </Button>
          <Button
            variant={action === "cancel" ? "destructive" : "default"}
            onClick={submit}
            disabled={saving || !reason.trim()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
            {verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
