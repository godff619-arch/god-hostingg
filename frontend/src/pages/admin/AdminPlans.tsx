// Admin Plans (/admin/plans) — plan catalog with quota management.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Layers,
  Plus,
  RefreshCw,
  Pencil,
  Copy,
  Trash2,
  Loader2,
  Users,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
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
import { adminGet, adminSend } from "@/lib/adminApi";
import type { Plan, PlanInput } from "@/lib/adminTypes";

const QUOTA_FIELDS: { key: keyof PlanInput; label: string }[] = [
  { key: "ram_mb", label: "RAM (MB)" },
  { key: "cpus_milli", label: "CPU (milli)" },
  { key: "storage_mb", label: "Storage (MB)" },
  { key: "max_apps", label: "Max apps" },
  { key: "max_domains", label: "Max domains" },
  { key: "max_backups", label: "Max backups" },
];

function fmtQuota(v: number | null): string {
  return v === null ? "Unlimited" : String(v);
}

function fmtPrice(cents: number, currency: string): string {
  if (!cents) return "Free";
  const amount = (cents / 100).toFixed(2);
  return `${currency?.toUpperCase() || "USD"} ${amount}`;
}

export default function AdminPlans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editPlan, setEditPlan] = useState<Plan | null>(null);
  const [deletePlan, setDeletePlan] = useState<Plan | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<Plan[]>("/plans");
      setPlans(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const openCreate = () => {
    setEditPlan(null);
    setFormOpen(true);
  };
  const openEdit = (plan: Plan) => {
    setEditPlan(plan);
    setFormOpen(true);
  };

  const handleDuplicate = async (plan: Plan) => {
    setBusyId(plan.id);
    try {
      await adminSend(`/plans/${plan.id}/duplicate`, "POST");
      toast.success(`Duplicated ${plan.name}`);
      fetchPlans();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate plan");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deletePlan) return;
    setBusyId(deletePlan.id);
    try {
      await adminSend(`/plans/${deletePlan.id}`, "DELETE");
      toast.success(`Deleted ${deletePlan.name}`);
      setDeletePlan(null);
      fetchPlans();
    } catch (err) {
      // Backend returns 409 with {error} when the plan is still in use.
      toast.error(err instanceof Error ? err.message : "Failed to delete plan");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Plans"
        description="Subscription tiers and their resource quotas."
        icon={Layers}
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchPlans}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button onClick={openCreate} className="h-10">
              <Plus className="h-4 w-4" />
              New plan
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-72 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          No plans yet. Create your first plan to get started.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const isAdmin = plan.key === "admin";
            return (
              <div
                key={plan.id}
                className="flex flex-col rounded-2xl border border-border/60 bg-card p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-lg font-bold">{plan.name}</h3>
                    <p className="text-xs text-muted-foreground">{plan.key}</p>
                  </div>
                  {plan.is_public ? (
                    <span className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600 dark:text-emerald-400">
                      Public
                    </span>
                  ) : (
                    <span className="rounded-lg border border-border/60 bg-secondary/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                      Private
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tabular-nums">
                    {fmtPrice(plan.price_cents, plan.currency)}
                  </span>
                  {plan.price_cents > 0 && (
                    <span className="text-xs text-muted-foreground">/ {plan.interval}</span>
                  )}
                </div>

                <dl className="mt-4 space-y-1.5 border-t border-border/40 pt-4 text-sm">
                  {QUOTA_FIELDS.map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-medium tabular-nums">{fmtQuota(plan[key] as number | null)}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {plan.user_count} {plan.user_count === 1 ? "user" : "users"}
                </div>

                <div className="mt-4 flex items-center gap-1.5 border-t border-border/40 pt-4">
                  <Button size="sm" variant="outline" onClick={() => openEdit(plan)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === plan.id}
                    onClick={() => handleDuplicate(plan)}
                  >
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-9 w-9"
                    title={isAdmin ? "The admin plan cannot be deleted" : "Delete plan"}
                    disabled={isAdmin || busyId === plan.id}
                    onClick={() => setDeletePlan(plan)}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PlanFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        plan={editPlan}
        onSaved={fetchPlans}
      />

      <Dialog open={deletePlan !== null} onOpenChange={(o) => !o && setDeletePlan(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10">
              <Trash2 className="h-6 w-6 text-red-500" />
            </div>
            <DialogTitle className="text-center">Delete plan</DialogTitle>
            <DialogDescription className="text-center">
              Delete <span className="font-semibold text-foreground">{deletePlan?.name}</span>?
              Plans currently assigned to users cannot be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDeletePlan(null)} className="flex-1">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={busyId === deletePlan?.id}
              className="flex-1"
            >
              {busyId === deletePlan?.id && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const EMPTY_FORM = {
  key: "",
  name: "",
  price_cents: "0",
  currency: "usd",
  interval: "month",
  is_public: true,
  ram_mb: "",
  cpus_milli: "",
  storage_mb: "",
  max_apps: "",
  max_domains: "",
  max_backups: "",
};

function PlanFormDialog({
  open,
  onOpenChange,
  plan,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: Plan | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(plan);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (plan) {
      setForm({
        key: plan.key,
        name: plan.name,
        price_cents: String(plan.price_cents),
        currency: plan.currency,
        interval: plan.interval,
        is_public: plan.is_public,
        ram_mb: plan.ram_mb != null ? String(plan.ram_mb) : "",
        cpus_milli: plan.cpus_milli != null ? String(plan.cpus_milli) : "",
        storage_mb: plan.storage_mb != null ? String(plan.storage_mb) : "",
        max_apps: plan.max_apps != null ? String(plan.max_apps) : "",
        max_domains: plan.max_domains != null ? String(plan.max_domains) : "",
        max_backups: plan.max_backups != null ? String(plan.max_backups) : "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, plan]);

  const set = (key: keyof typeof EMPTY_FORM, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    if (!form.key.trim() || !form.name.trim()) {
      toast.error("Key and name are required");
      return;
    }
    const quota = (v: string): number | null => (v.trim() === "" ? null : Number(v));
    const payload: PlanInput = {
      key: form.key.trim(),
      name: form.name.trim(),
      price_cents: Number(form.price_cents) || 0,
      currency: form.currency.trim() || "usd",
      interval: form.interval.trim() || "month",
      is_public: form.is_public,
      ram_mb: quota(form.ram_mb),
      cpus_milli: quota(form.cpus_milli),
      storage_mb: quota(form.storage_mb),
      max_apps: quota(form.max_apps),
      max_domains: quota(form.max_domains),
      max_backups: quota(form.max_backups),
    };
    setSaving(true);
    try {
      if (isEdit && plan) {
        await adminSend(`/plans/${plan.id}`, "PATCH", payload);
        toast.success("Plan updated");
      } else {
        await adminSend("/plans", "POST", payload);
        toast.success("Plan created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save plan");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit plan" : "New plan"}</DialogTitle>
          <DialogDescription>
            Leave a quota blank to make it unlimited.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <Input value={form.key} onChange={(e) => set("key", e.target.value)} placeholder="pro" />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Pro" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Price (cents)">
              <Input
                type="number"
                value={form.price_cents}
                onChange={(e) => set("price_cents", e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input value={form.currency} onChange={(e) => set("currency", e.target.value)} placeholder="usd" />
            </Field>
            <Field label="Interval">
              <SelectBox value={form.interval} onChange={(v) => set("interval", v)}>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </SelectBox>
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_public}
              onChange={(e) => set("is_public", e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Publicly selectable
          </label>

          <div className="border-t border-border/40 pt-3">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">
              Quotas (blank = unlimited)
            </p>
            <div className="grid grid-cols-2 gap-3">
              {QUOTA_FIELDS.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <Input
                    type="number"
                    value={form[key as keyof typeof EMPTY_FORM] as string}
                    onChange={(e) => set(key as keyof typeof EMPTY_FORM, e.target.value)}
                    placeholder="unlimited"
                  />
                </Field>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="flex-1">
            <X className="h-4 w-4" /> Cancel
          </Button>
          <Button onClick={submit} disabled={saving} className="flex-1">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {isEdit ? "Save changes" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SelectBox({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-11 w-full rounded-xl border-2 border-border bg-background px-3 text-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
    >
      {children}
    </select>
  );
}
