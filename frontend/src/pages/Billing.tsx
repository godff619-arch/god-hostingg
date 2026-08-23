// Workspace Billing — spec Part C §1–§40.
//
// Every number on this page comes from `GET /api/billing`, which derives usage
// from real UsageRecord rows and allowances from plan config. Nothing is
// hardcoded per-account (§81): an untouched month legitimately reads 0, and an
// unlimited allowance renders "Unlimited" rather than a full bar.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Download,
  Gift,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlanBadge } from "@/components/workspace/PlanGate";
import { TocLayout, TocSection, type TocItem } from "@/components/workspace/PageToc";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { apiDownload, apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type {
  BillingPayload,
  BillingProfile,
  InvoiceRow,
  PaymentMethodRow,
  PlanOption,
  UnbilledGroup,
  UsageMeter,
} from "@/lib/workspaceTypes";

/**
 * Scopes every request on this page to the workspace being viewed. On
 * `/workspace/:workspaceId/billing` that is the URL's workspace; on `/billing` it
 * is the header switcher's selection. Mutations must target the same workspace as
 * the data they were rendered from, so they read this rather than calling
 * `scoped()` directly.
 */
const ScopeCtx = createContext<(path: string) => string>(scoped);

function useScope(): (path: string) => string {
  return useContext(ScopeCtx);
}

const SECTIONS: TocItem[] = [
  { id: "plan", label: "Plan" },
  { id: "payment-method", label: "Payment Method" },
  { id: "billing-information", label: "Billing Information" },
  { id: "included-usage", label: "Included Usage" },
  { id: "unbilled-charges", label: "Unbilled Charges" },
  { id: "credit-balance", label: "Credit Balance" },
  { id: "invoice-history", label: "Invoice History" },
];

/** Integer cents → `$12.34`. Money is never floated through the client. */
function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function amount(value: number, digits = 2): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** `2026-08` → `August 2026`. */
function periodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function Billing() {
  // `/workspace/:workspaceId/billing` targets a workspace explicitly; `/billing`
  // falls back to the one selected in the header switcher.
  const { workspaceId } = useParams();
  const { refresh: refreshWorkspace, canWrite } = useWorkspace();
  const [data, setData] = useState<BillingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scope = useMemo<(path: string) => string>(
    () =>
      workspaceId
        ? (path: string) =>
            `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`
        : scoped,
    [workspaceId],
  );

  const path = useMemo(() => scope("/api/billing"), [scope]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<BillingPayload>(path));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    await load();
    await refreshWorkspace();
  }, [load, refreshWorkspace]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[1160px] space-y-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-secondary/50" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-md border border-border bg-card" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load billing."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="mx-auto mb-6 flex w-full max-w-[1160px] flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[27px] font-medium leading-tight text-foreground">Billing</h1>
          <PlanBadge tier={data.workspace.plan.key} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{data.workspace.name}</span>
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh billing"
            onClick={() => void reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
        </div>
      </div>

      <TocLayout sections={SECTIONS}>
        <ScopeCtx.Provider value={scope}>
          <div className="space-y-8 pb-16">
            {error ? (
              <div className="rounded-md border border-danger-border bg-danger-surface p-3 text-[12px] text-danger">
                {error}
              </div>
            ) : null}

            <PlanSection data={data} canWrite={canWrite} onChanged={reload} />
            <PaymentMethodSection data={data} canWrite={canWrite} onChanged={reload} />
            <BillingInformationSection data={data} canWrite={canWrite} onChanged={reload} />
            <IncludedUsageSection data={data} />
            <UnbilledChargesSection data={data} />
            <CreditBalanceSection data={data} canWrite={canWrite} onChanged={reload} />
            <InvoiceHistorySection invoices={data.invoices} />
          </div>
        </ScopeCtx.Provider>
      </TocLayout>
    </div>
  );
}

// ------------------------------------------------------------------ Plan (§8–§13)

function PlanSection({
  data,
  canWrite,
  onChanged,
}: {
  data: BillingPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [target, setTarget] = useState<PlanOption | null>(null);
  const current = data.workspace.plan.key;
  const currentPlan = data.plans.find((p) => p.key === current);

  return (
    <TocSection
      id="plan"
      title="Plan"
      description="The plan applies to this workspace and every resource inside it."
    >
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-medium text-foreground">
                {currentPlan?.name ?? data.workspace.plan.label}
              </span>
              <PlanBadge tier={current} />
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {currentPlan
                ? `${currentPlan.price_cents === 0 ? "Free" : `${money(currentPlan.price_cents)} / month`} — ${currentPlan.blurb}`
                : "Current plan."}
            </p>
          </div>
        </div>
      </div>

      <h3 className="mt-6 text-[13px] font-medium text-foreground">Plan Benefits</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {data.plans.map((plan) => {
          const isCurrent = plan.key === current;
          return (
            <div
              key={plan.key}
              className={cn(
                "flex flex-col rounded-md border p-4",
                isCurrent ? "border-brand-strong bg-brand/15" : "border-border bg-card",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-medium text-foreground">{plan.name}</span>
                {isCurrent ? (
                  <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground">
                    Current
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-[19px] font-medium text-foreground">
                {plan.price_cents === 0 ? "Free" : money(plan.price_cents)}
                {plan.price_cents === 0 ? null : (
                  <span className="text-[12px] font-normal text-muted-foreground"> / month</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{plan.blurb}</p>
              <ul className="mt-3 space-y-1.5">
                {plan.benefits.map((benefit) => (
                  <li key={benefit} className="flex gap-2 text-[12px] text-muted-foreground">
                    <Check className="mt-[2px] h-3 w-3 shrink-0 text-success" strokeWidth={2} />
                    <span>{benefit}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant={isCurrent ? "outline" : "default"}
                className="mt-4 w-full"
                disabled={isCurrent || !canWrite}
                onClick={() => setTarget(plan)}
              >
                {isCurrent
                  ? "Current plan"
                  : plan.price_cents > (data.plans.find((p) => p.key === current)?.price_cents ?? 0)
                    ? `Upgrade to ${plan.name}`
                    : `Switch to ${plan.name}`}
              </Button>
            </div>
          );
        })}
      </div>

      <ConfirmPlanChange
        plan={target}
        currentLabel={currentPlan?.name ?? data.workspace.plan.label}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onDone={onChanged}
      />
    </TocSection>
  );
}

/** Plan changes are billed, so they go through an explicit confirmation (§77). */
function ConfirmPlanChange({
  plan,
  currentLabel,
  onOpenChange,
  onDone,
}: {
  plan: PlanOption | null;
  currentLabel: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    if (!plan) return;
    setSaving(true);
    try {
      await apiSend(scope("/api/billing/plan"), "PATCH", { plan_key: plan.key });
      toast.success(`Plan updated to ${plan.name}`);
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!plan} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update plan?</DialogTitle>
          <DialogDescription>
            This workspace moves from {currentLabel} to {plan?.name}.
            {plan && plan.price_cents > 0
              ? ` ${money(plan.price_cents)} per month will be added to your unbilled charges.`
              : " Paid features stop being available immediately."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={() => void apply()}>
            {saving ? "Updating…" : `Update to ${plan?.name ?? ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------- Payment Method (§14–§19)

function PaymentMethodSection({
  data,
  canWrite,
  onChanged,
}: {
  data: BillingPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const scope = useScope();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<PaymentMethodRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const makeDefault = async (method: PaymentMethodRow) => {
    setBusy(method.id);
    try {
      await apiSend(scope(`/api/billing/payment-methods/${method.id}/default`), "POST");
      toast.success("Default payment method updated");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <TocSection
      id="payment-method"
      title="Payment Method"
      description="Cards are tokenized by the payment provider — Docklift stores only the brand, last four digits and expiry."
      action={
        canWrite ? (
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add card
          </Button>
        ) : null
      }
    >
      {data.payment_methods.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center">
          <CreditCard
            className="mx-auto h-5 w-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden
          />
          <p className="mt-2 text-[14px] text-foreground">No card on file.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Add a payment method to move off the Hobby plan.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {data.payment_methods.map((method) => (
            <div key={method.id} className="flex flex-wrap items-center gap-3 p-3.5">
              <CreditCard className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-foreground">
                    {method.brand} •••• {method.last4}
                  </span>
                  {method.is_default ? (
                    <span className="rounded-[3px] border border-border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                      Default
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Expires {String(method.exp_month).padStart(2, "0")}/
                  {String(method.exp_year).slice(-2)}
                </p>
              </div>
              {canWrite ? (
                <div className="flex items-center gap-2">
                  {method.is_default ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === method.id}
                      onClick={() => void makeDefault(method)}
                    >
                      {busy === method.id ? "Saving…" : "Set as default"}
                    </Button>
                  )}
                  <Button
                    variant="bare"
                    size="icon"
                    aria-label={`Remove card ending ${method.last4}`}
                    onClick={() => setRemoving(method)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <AddCardDialog open={addOpen} onOpenChange={setAddOpen} onDone={onChanged} />
      <RemoveCardDialog
        method={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        onDone={onChanged}
      />
    </TocSection>
  );
}

/**
 * Add Card. The form deliberately collects the *tokenized* card, not a PAN — the
 * server rejects any 12+ digit run with `RAW_CARD`, so a real card number typed
 * here would be refused rather than stored.
 */
function AddCardDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [token, setToken] = useState("");
  const [brand, setBrand] = useState("Visa");
  const [last4, setLast4] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToken("");
    setBrand("Visa");
    setLast4("");
    setExpMonth("");
    setExpYear("");
  }, [open]);

  const valid =
    token.trim().length > 0 &&
    /^\d{4}$/.test(last4) &&
    Number(expMonth) >= 1 &&
    Number(expMonth) <= 12 &&
    /^\d{4}$/.test(expYear);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await apiSend(scope("/api/billing/payment-methods"), "POST", {
        provider_ref: token.trim(),
        brand: brand.trim(),
        last4,
        exp_month: Number(expMonth),
        exp_year: Number(expYear),
      });
      toast.success("Card added");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add a card</DialogTitle>
            <DialogDescription>
              Paste the token your payment provider returned. Full card numbers are rejected.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <Field label="Provider token" htmlFor="pm-token">
              <Input
                id="pm-token"
                value={token}
                autoFocus
                placeholder="pm_1NXxxxxxxxxxxx"
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Brand" htmlFor="pm-brand">
                <Input
                  id="pm-brand"
                  value={brand}
                  maxLength={20}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </Field>
              <Field label="Last 4 digits" htmlFor="pm-last4">
                <Input
                  id="pm-last4"
                  value={last4}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="4242"
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expiry month" htmlFor="pm-month">
                <Input
                  id="pm-month"
                  value={expMonth}
                  inputMode="numeric"
                  maxLength={2}
                  placeholder="08"
                  onChange={(e) => setExpMonth(e.target.value.replace(/\D/g, "").slice(0, 2))}
                />
              </Field>
              <Field label="Expiry year" htmlFor="pm-year">
                <Input
                  id="pm-year"
                  value={expYear}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="2029"
                  onChange={(e) => setExpYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </Field>
            </div>
          </div>
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !valid}>
              {saving ? "Adding…" : "Add card"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Label + control pair used by the billing dialogs. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function RemoveCardDialog({
  method,
  onOpenChange,
  onDone,
}: {
  method: PaymentMethodRow | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [saving, setSaving] = useState(false);

  const remove = async () => {
    if (!method) return;
    setSaving(true);
    try {
      await apiSend(scope(`/api/billing/payment-methods/${method.id}`), "DELETE");
      toast.success("Card removed");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!method} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this card?</DialogTitle>
          <DialogDescription>
            {method
              ? `${method.brand} •••• ${method.last4} will no longer be charged. A paid plan needs at least one card on file.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={saving}
            onClick={() => void remove()}
          >
            {saving ? "Removing…" : "Remove card"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------- Billing Information (§20–§23)

const PROFILE_FIELDS: Array<{ key: keyof BillingProfile; label: string; max?: number }> = [
  { key: "company", label: "Company" },
  { key: "address1", label: "Address line 1" },
  { key: "address2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State / Province" },
  { key: "postal_code", label: "Postal code", max: 20 },
  { key: "country", label: "Country" },
  { key: "vat_id", label: "VAT / Tax ID", max: 40 },
];

function BillingInformationSection({
  data,
  canWrite,
  onChanged,
}: {
  data: BillingPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const profile = data.billing_profile;
  const filled = profile ? PROFILE_FIELDS.filter((f) => profile[f.key]) : [];

  return (
    <TocSection
      id="billing-information"
      title="Billing Information"
      description="Shown on every invoice for this workspace."
      action={
        canWrite ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            {profile ? "Edit" : "Add details"}
          </Button>
        ) : null
      }
    >
      {filled.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center">
          <p className="text-[14px] text-foreground">No billing information.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Add a company name and address to have them appear on invoices.
          </p>
        </div>
      ) : (
        <dl className="grid gap-x-8 gap-y-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2">
          {filled.map((field) => (
            <div key={field.key}>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-subtle">{field.label}</dt>
              <dd className="mt-0.5 text-[13px] text-foreground">{profile?.[field.key]}</dd>
            </div>
          ))}
        </dl>
      )}

      <BillingProfileDialog
        open={open}
        onOpenChange={setOpen}
        profile={profile}
        onDone={onChanged}
      />
    </TocSection>
  );
}

function BillingProfileDialog({
  open,
  onOpenChange,
  profile,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: BillingProfile | null;
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) next[field.key] = profile?.[field.key] ?? "";
    setForm(next);
  }, [open, profile]);

  // An address is only meaningful with a country, so require it alongside one.
  const hasAddress = !!form.address1?.trim();
  const missingCountry = hasAddress && !form.country?.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (missingCountry) return;
    setSaving(true);
    try {
      await apiSend(scope("/api/billing/profile"), "PUT", form);
      toast.success("Billing information saved");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Billing information</DialogTitle>
            <DialogDescription>
              Leave a field blank to omit it from your invoices.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} htmlFor={`bp-${field.key}`}>
                <Input
                  id={`bp-${field.key}`}
                  value={form[field.key] ?? ""}
                  maxLength={field.max ?? 120}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
          {missingCountry ? (
            <p className="mt-3 text-[12px] text-danger">Country is required with an address.</p>
          ) : null}
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || missingCountry}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------ Monthly Included Usage (§24–§30)

function IncludedUsageSection({ data }: { data: BillingPayload }) {
  const usage = data.included_usage;
  return (
    <TocSection
      id="included-usage"
      title="Monthly Included Usage"
      description={`Allowances reset at the start of each billing period. Period: ${periodLabel(data.period)}.`}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <MeterCard
          title="Free Instance Hours"
          meter={usage.instance_hours}
          format={(v) => `${amount(v, 1)} hrs`}
        />
        <MeterCard
          title="Included Custom Domains"
          meter={usage.custom_domains}
          format={(v) => `${amount(v, 0)}`}
        />
        <MeterCard
          title="Included Services"
          meter={usage.services}
          format={(v) => `${amount(v, 0)}`}
        />
        <MeterCard
          title="Included Pipeline Minutes"
          meter={usage.pipeline_minutes}
          format={(v) => `${amount(v, 0)} min`}
          action={
            <Link
              to="/workspace/settings#build-pipeline"
              className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Manage
            </Link>
          }
        />
        <div className="md:col-span-2">
          <MeterCard
            title="Included Bandwidth"
            meter={usage.bandwidth}
            format={(v) => `${amount(v, 2)} GB`}
          >
            <dl className="mt-3 grid gap-x-6 gap-y-1.5 border-t border-border pt-3 sm:grid-cols-2">
              <BreakdownRow label="HTTP Responses" gb={usage.bandwidth.breakdown.http_response} />
              <BreakdownRow
                label="Service-Initiated"
                gb={usage.bandwidth.breakdown.service_initiated}
              />
              <BreakdownRow label="WebSocket Responses" gb={usage.bandwidth.breakdown.websocket} />
              <BreakdownRow
                label="Service-Initiated Private Link"
                gb={usage.bandwidth.breakdown.private_link}
              />
            </dl>
          </MeterCard>
        </div>
      </div>
    </TocSection>
  );
}

function BreakdownRow({ label, gb }: { label: string; gb: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[12px] tabular-nums text-foreground">{amount(gb, 2)} GB</dd>
    </div>
  );
}

/**
 * One allowance meter. The percentage is computed server-side from real usage;
 * an unlimited allowance has no denominator, so no bar is drawn (§24).
 */
function MeterCard({
  title,
  meter,
  format,
  action,
  children,
}: {
  title: string;
  meter: UsageMeter;
  format: (value: number) => string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const unlimited = meter.limit === null;
  const percent = meter.percent ?? 0;
  const over = percent >= 100;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {action}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[19px] font-medium tabular-nums text-foreground">
          {format(meter.used)}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {unlimited ? "used — unlimited on this plan" : `of ${format(meter.limit as number)}`}
        </span>
      </div>
      {unlimited ? null : (
        <>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn("h-full rounded-full", over ? "bg-danger" : "bg-brand-strong")}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
            {percent.toFixed(1)}% used
          </p>
        </>
      )}
      {children}
    </div>
  );
}

// ----------------------------------------------- Unbilled Charges (§31–§35)

function UnbilledChargesSection({ data }: { data: BillingPayload }) {
  const scope = useScope();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const groups = data.unbilled.groups;

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const download = async () => {
    setDownloading(true);
    try {
      await apiDownload(
        scope(`/api/billing/usage.csv?period=${encodeURIComponent(data.period)}`),
        `workspace-billing-${data.period}.csv`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <TocSection
      id="unbilled-charges"
      title="Unbilled Charges"
      description={`Usage recorded so far in ${periodLabel(data.period)}, not yet invoiced.`}
      action={
        <div className="flex items-center gap-2">
          {groups.length > 0 ? (
            <Button
              variant="bare"
              className="text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() =>
                setExpanded((prev) =>
                  prev.size === groups.length
                    ? new Set()
                    : new Set(groups.map((g) => groupKey(g))),
                )
              }
            >
              {expanded.size === groups.length ? "Collapse All" : "Expand All"}
            </Button>
          ) : null}
          <Button variant="outline" disabled={downloading} onClick={() => void download()}>
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Download as CSV
          </Button>
        </div>
      }
    >
      {groups.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center">
          <p className="text-[14px] text-foreground">No charges this period.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Metered usage appears here as it is recorded.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {groups.map((group) => {
            const key = groupKey(group);
            const open = expanded.has(key);
            return (
              <div key={key}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(key)}
                  className="flex w-full items-center gap-2 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-hover"
                >
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                  ) : (
                    <ChevronRight
                      className="h-3.5 w-3.5 text-muted-foreground"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {group.resource}
                  </span>
                  <span className="text-[13px] tabular-nums text-foreground">
                    {money(group.cents)}
                  </span>
                </button>
                {open ? (
                  <dl className="grid gap-x-6 gap-y-1.5 border-t border-border bg-secondary/20 px-3.5 py-3 sm:grid-cols-2">
                    <BreakdownText label="Resource type" value={group.resource_type} />
                    <BreakdownText
                      label="Usage"
                      value={`${amount(group.quantity, 2)} ${group.unit}`}
                    />
                    <BreakdownText label="Amount" value={money(group.cents)} />
                    <BreakdownText label="Period" value={periodLabel(data.period)} />
                  </dl>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 space-y-2 rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">Total month to date</span>
          <span className="text-[15px] font-medium tabular-nums text-foreground">
            {money(data.unbilled.total_cents)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">Projected total</span>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {money(data.unbilled.projected_cents)}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-subtle">
          The projection extrapolates the current run rate over the whole month. It is an estimate,
          not a charge.
        </p>
      </div>
    </TocSection>
  );
}

function groupKey(group: UnbilledGroup): string {
  return `${group.resource}|${group.resource_type}|${group.unit}`;
}

function BreakdownText({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[12px] text-foreground">{value}</dd>
    </div>
  );
}

// -------------------------------------------------- Credit Balance (§36–§37)

function CreditBalanceSection({
  data,
  canWrite,
  onChanged,
}: {
  data: BillingPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const scope = useScope();
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  const redeem = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const result = await apiSend<{ added_cents: number }>(scope("/api/billing/promo"), "POST", {
        code: trimmed,
      });
      toast.success(`${money(result.added_cents)} in credit added`);
      setCode("");
      await onChanged();
    } catch (err) {
      // INVALID_CODE / EXPIRED / ALREADY_REDEEMED / FULLY_REDEEMED all arrive as
      // a specific message from the server — show it verbatim.
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <TocSection
      id="credit-balance"
      title="Credit Balance"
      description="Credit is applied to your charges before your card is billed."
    >
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[24px] font-medium tabular-nums text-foreground">
            {money(data.credit.balance_cents)}
          </span>
          <span className="text-[12px] text-muted-foreground">available credit</span>
        </div>
        {canWrite ? (
          <form onSubmit={redeem} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <label htmlFor="promo-code" className="text-[12px] text-muted-foreground">
                Promo code
              </label>
              <Input
                id="promo-code"
                value={code}
                maxLength={40}
                placeholder="Enter a code"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
            <Button type="submit" variant="outline" disabled={saving || !code.trim()}>
              <Gift className="h-3.5 w-3.5" strokeWidth={1.75} />
              {saving ? "Redeeming…" : "Redeem"}
            </Button>
          </form>
        ) : null}
      </div>
    </TocSection>
  );
}

// ------------------------------------------------- Invoice History (§38–§40)

const INVOICE_STATUS: Record<string, string> = {
  paid: "border-success-border bg-success-surface text-success",
  pending: "border-warning-border bg-warning-surface text-warning",
  failed: "border-danger-border bg-danger-surface text-danger",
  refunded: "border-border text-muted-foreground",
};

function InvoiceHistorySection({ invoices }: { invoices: InvoiceRow[] }) {
  const scope = useScope();
  const [viewing, setViewing] = useState<InvoiceRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const downloadPdf = async (invoice: InvoiceRow) => {
    setBusy(invoice.id);
    try {
      await apiDownload(
        scope(`/api/billing/invoices/${encodeURIComponent(invoice.id)}/pdf`),
        `${invoice.id}.pdf`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <TocSection id="invoice-history" title="Invoice History">
      {invoices.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center">
          <p className="text-[14px] text-foreground">No past invoices.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Invoices appear here at the end of each billing period.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {["Invoice ID", "Date", "Period", "Amount", "Status", ""].map((head) => (
                  <th
                    key={head}
                    scope="col"
                    className="px-3.5 py-2.5 text-left text-[10px] font-medium uppercase tracking-[0.09em] text-subtle"
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-border last:border-0">
                  <td className="px-3.5 py-3 font-mono text-[12px] text-foreground">
                    {invoice.id}
                  </td>
                  <td className="px-3.5 py-3 text-[12px] text-muted-foreground">
                    {dateLabel(invoice.issued_at)}
                  </td>
                  <td className="px-3.5 py-3 text-[12px] text-muted-foreground">
                    {dateLabel(invoice.period_start)} – {dateLabel(invoice.period_end)}
                  </td>
                  <td className="px-3.5 py-3 text-[12px] tabular-nums text-foreground">
                    {money(invoice.amount_cents)} {invoice.currency}
                  </td>
                  <td className="px-3.5 py-3">
                    <span
                      className={cn(
                        "inline-flex rounded-[3px] border px-1.5 py-[3px] text-[11px] capitalize",
                        INVOICE_STATUS[invoice.status] ?? "border-border text-muted-foreground",
                      )}
                    >
                      {invoice.status}
                    </span>
                  </td>
                  <td className="px-3.5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setViewing(invoice)}>
                        View
                      </Button>
                      {/* Only offered when a PDF actually exists on the server. */}
                      {invoice.has_pdf ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === invoice.id}
                          onClick={() => void downloadPdf(invoice)}
                        >
                          {busy === invoice.id ? "Downloading…" : "Download PDF"}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invoice {viewing?.id}</DialogTitle>
            <DialogDescription>
              {viewing
                ? `Issued ${dateLabel(viewing.issued_at)} for ${dateLabel(viewing.period_start)} – ${dateLabel(viewing.period_end)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {viewing ? (
            <dl className="space-y-2">
              <BreakdownText
                label="Amount"
                value={`${money(viewing.amount_cents)} ${viewing.currency}`}
              />
              <BreakdownText label="Status" value={viewing.status} />
              <BreakdownText label="PDF" value={viewing.has_pdf ? "Available" : "Not generated"} />
            </dl>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TocSection>
  );
}
