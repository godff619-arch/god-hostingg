// Create or edit a coupon — §13.
//
// The form mirrors `couponData()` on the server field for field, including the
// switches that make a field meaningless: a percent coupon has no cash amount
// (the server forces `amount_cents` to 0 so a discount can never be mistaken for
// wallet money), and only a `months` coupon has a month count. Rather than send
// values the server will discard, the form hides them.
//
// The code cannot be edited after creation. `PromoCode.code` is what a redemption
// row points at and what a customer typed into a checkout; renaming it would
// rewrite history. The server ignores `code` on PATCH, so the input is disabled
// rather than silently ineffective.

import { useEffect, useMemo, useState } from "react";
import { Loader2, TicketPercent } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, SelectBox } from "@/components/admin/AdminList";
import { adminSend } from "@/lib/adminApi";
import type { CouponRow, PlanFacet } from "@/lib/adminBillingTypes";
import { centsToInput, inputToCents } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** `2026-09-05T00:00:00.000Z` → `2026-09-05`, which is what `<input type=date>` wants. */
function dateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

export function CouponEditorDialog({
  open,
  coupon,
  plans,
  kinds,
  durations,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null ⇒ creating. */
  coupon: CouponRow | null;
  plans: PlanFacet[];
  kinds: string[];
  durations: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(coupon);

  const [code, setCode] = useState("");
  const [kind, setKind] = useState("fixed");
  const [amount, setAmount] = useState("5.00");
  const [percent, setPercent] = useState("20");
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState("once");
  const [months, setMonths] = useState("3");
  const [planKeys, setPlanKeys] = useState<string[]>([]);
  const [startsAt, setStartsAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxRedemables, setMaxRedemables] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode(coupon?.code ?? "");
    setKind(coupon?.kind ?? "fixed");
    setAmount(centsToInput(coupon?.amount_cents ?? 500));
    setPercent(String(coupon?.percent_off ?? 20));
    setDescription(coupon?.description ?? "");
    setDuration(coupon?.duration ?? "once");
    setMonths(String(coupon?.duration_months ?? 3));
    setPlanKeys(coupon?.plan_keys ?? []);
    setStartsAt(dateInput(coupon?.starts_at ?? null));
    setExpiresAt(dateInput(coupon?.expires_at ?? null));
    setMaxRedemables(coupon?.max_redemables ? String(coupon.max_redemables) : "");
    setActive(coupon?.active ?? true);
    setSaving(false);
  }, [open, coupon]);

  const codeValid = editing || /^[A-Z0-9_-]{3,40}$/.test(code);
  const amountCents = inputToCents(amount);
  const percentValue = Number(percent);
  const monthsValue = Number(months);

  const problem = useMemo<string | null>(() => {
    if (!codeValid) return "Code must be 3–40 characters: A–Z, 0–9, - or _.";
    if (kind === "percent") {
      if (!Number.isFinite(percentValue) || percentValue < 1 || percentValue > 100) {
        return "Percent off must be 1–100.";
      }
    } else if (amountCents === null || amountCents < 1) {
      return "Amount must be at least one cent.";
    }
    if (duration === "months" && (!Number.isFinite(monthsValue) || monthsValue < 1 || monthsValue > 60)) {
      return "A repeating coupon needs 1–60 months.";
    }
    if (startsAt && expiresAt && new Date(expiresAt).getTime() <= new Date(startsAt).getTime()) {
      return "Expiry must be after the start date.";
    }
    return null;
  }, [codeValid, kind, percentValue, amountCents, duration, monthsValue, startsAt, expiresAt]);

  const submit = async () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const body = {
        code,
        kind,
        amount_cents: kind === "percent" ? 0 : amountCents,
        percent_off: kind === "percent" ? percentValue : null,
        description: description.trim() || null,
        duration,
        duration_months: duration === "months" ? monthsValue : null,
        plan_keys: planKeys,
        // An empty date field means "no boundary", which the server reads as null.
        starts_at: startsAt ? new Date(`${startsAt}T00:00:00`).toISOString() : null,
        expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
        max_redemables: maxRedemables.trim() ? Number(maxRedemables) : null,
        active,
      };
      const res = coupon
        ? await adminSend<{ message?: string }>(`/coupons/${coupon.id}`, "PATCH", body)
        : await adminSend<{ message?: string }>("/coupons", "POST", body);
      toast.success(res.message || (coupon ? `${code} updated.` : `${code} created.`));
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The coupon was not saved.");
    } finally {
      setSaving(false);
    }
  };

  const togglePlan = (key: string) => {
    setPlanKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10">
            <TicketPercent className="h-6 w-6 text-brand" />
          </div>
          <DialogTitle className="text-center">
            {editing ? `Edit ${coupon?.code}` : "New coupon"}
          </DialogTitle>
          <DialogDescription className="text-center">
            A coupon discounts a subscription at checkout. It is not credit and never
            becomes a balance.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field
            label="Code"
            hint={
              editing
                ? "Fixed after creation — redemptions and customer emails already point at it."
                : "What the customer types. Letters, digits, - and _."
            }
          >
            <Input
              value={code}
              disabled={editing}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
              placeholder="LAUNCH20"
              className={cn("font-mono uppercase", editing && "opacity-70")}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Discount type">
              <SelectBox value={kind} onChange={setKind}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {k === "percent" ? "Percentage off" : "Fixed amount off"}
                  </option>
                ))}
              </SelectBox>
            </Field>

            {kind === "percent" ? (
              <Field label="Percent off" hint="1–100.">
                <Input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Amount off" hint="In the platform currency.">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Applies for">
              <SelectBox value={duration} onChange={setDuration}>
                {durations.map((d) => (
                  <option key={d} value={d}>
                    {d === "once"
                      ? "The first invoice only"
                      : d === "forever"
                        ? "Every invoice, forever"
                        : "A number of months"}
                  </option>
                ))}
              </SelectBox>
            </Field>
            {duration === "months" && (
              <Field label="Months" hint="1–60.">
                <Input
                  type="number"
                  min="1"
                  max="60"
                  step="1"
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              </Field>
            )}
          </div>

          <Field
            label="Valid on"
            hint={
              planKeys.length === 0
                ? "Nothing selected ⇒ valid on every plan."
                : `Restricted to ${planKeys.length} plan${planKeys.length === 1 ? "" : "s"}.`
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {plans.map((p) => {
                const on = planKeys.includes(p.key);
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => togglePlan(p.key)}
                    className={cn(
                      "press rounded-full border px-3 py-1.5 text-xs font-medium",
                      on
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border/60 text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" hint="Blank ⇒ immediately.">
              <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="Expires" hint="Blank ⇒ never.">
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          </div>

          <Field
            label="Redemption limit"
            hint="Blank ⇒ unlimited. Reaching the limit exhausts the coupon rather than deleting it."
          >
            <Input
              type="number"
              min="1"
              step="1"
              value={maxRedemables}
              onChange={(e) => setMaxRedemables(e.target.value)}
              placeholder="Unlimited"
            />
          </Field>

          <Field label="Description" hint="Internal note — why this coupon exists.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="e.g. 20% off the first month for the September launch campaign."
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
            />
            <span className="text-xs">
              <span className="block font-semibold text-foreground">Active</span>
              <span className="block text-muted-foreground">
                Switch off to stop new redemptions without touching the coupons already
                applied to a subscription.
              </span>
            </span>
          </label>

          {problem && (
            <p className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2 text-xs text-danger">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || Boolean(problem)}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create coupon"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
