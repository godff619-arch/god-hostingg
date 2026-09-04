// Admin Settings (/admin/settings) — platform configuration form.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Settings, Save, Loader2, Flag, AlertTriangle, Download, Archive } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { adminGet, adminSend, adminDownload } from "@/lib/adminApi";
import type { AdminSettings as SettingsData, Plan } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

export default function AdminSettings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        adminGet<SettingsData>("/settings"),
        adminGet<Plan[]>("/plans").catch(() => [] as Plan[]),
      ]);
      setSettings(s);
      setPlans(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const update = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) =>
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));

  const toggleFlag = (flag: string) =>
    setSettings((prev) =>
      prev
        ? { ...prev, feature_flags: { ...prev.feature_flags, [flag]: !prev.feature_flags[flag] } }
        : prev,
    );

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await adminSend("/settings", "PATCH", {
        platform_name: settings.platform_name,
        registration_enabled: settings.registration_enabled,
        deployments_enabled: settings.deployments_enabled,
        default_plan_key: settings.default_plan_key,
        maintenance_mode: settings.maintenance_mode,
        maintenance_message: settings.maintenance_message,
        feature_flags: settings.feature_flags,
        audit_retention_days: settings.audit_retention_days,
        error_retention_days: settings.error_retention_days,
        error_resolved_retention_days: settings.error_resolved_retention_days,
      });
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const exportAudit = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      await adminDownload(`/audit-logs/export?format=${format}`, `audit-logs.${format}`);
      toast.success(`Exported audit log as ${format.toUpperCase()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
        <div className="h-64 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-16 text-center">
        <p className="text-sm text-danger">{error || "Settings unavailable"}</p>
        <Button variant="outline" className="mt-4" onClick={fetchSettings}>
          Retry
        </Button>
      </div>
    );
  }

  const flagKeys = Object.keys(settings.feature_flags ?? {});

  return (
    <>
      <PageHeader
        title="Settings"
        description="Platform-wide configuration and feature flags."
        icon={Settings}
        actions={
          <Button onClick={handleSave} disabled={saving} className="h-10">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        }
      />

      <div className="space-y-4">
        <SettingsCard title="General">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Platform name</span>
            <Input
              value={settings.platform_name}
              onChange={(e) => update("platform_name", e.target.value)}
              placeholder="God Hosting"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Default plan</span>
            <select
              value={settings.default_plan_key}
              onChange={(e) => update("default_plan_key", e.target.value)}
              className="flex h-11 w-full rounded-xl border-2 border-border bg-background px-3 text-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {!plans.some((p) => p.key === settings.default_plan_key) && (
                <option value={settings.default_plan_key}>
                  {settings.default_plan_key || "— none —"}
                </option>
              )}
              {plans.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </label>
        </SettingsCard>

        <SettingsCard title="Access">
          <Toggle
            label="Registration enabled"
            description="Allow new users to sign up."
            checked={settings.registration_enabled}
            onChange={(v) => update("registration_enabled", v)}
          />
          <Toggle
            label="Deployments enabled"
            description="Allow users to build and deploy applications."
            checked={settings.deployments_enabled}
            onChange={(v) => update("deployments_enabled", v)}
          />
        </SettingsCard>

        <SettingsCard title="Maintenance">
          <Toggle
            label="Maintenance mode"
            description="Show a maintenance banner and restrict access."
            checked={settings.maintenance_mode}
            onChange={(v) => update("maintenance_mode", v)}
            tone="warning"
          />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Maintenance message</span>
            <Textarea
              value={settings.maintenance_message}
              onChange={(e) => update("maintenance_message", e.target.value)}
              placeholder="We'll be back shortly…"
              className="min-h-[90px] rounded-xl"
            />
          </label>
        </SettingsCard>

        <SettingsCard title="Log retention & export">
          <p className="text-xs text-muted-foreground">
            How long to keep the audit trail and Error Center before the daily sweep
            prunes them. Enter <span className="font-medium text-foreground">0</span> to keep
            forever.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <RetentionField
              label="Audit logs"
              value={settings.audit_retention_days}
              onChange={(v) => update("audit_retention_days", v)}
            />
            <RetentionField
              label="Open errors"
              value={settings.error_retention_days}
              onChange={(v) => update("error_retention_days", v)}
            />
            <RetentionField
              label="Resolved errors"
              value={settings.error_resolved_retention_days}
              onChange={(v) => update("error_resolved_retention_days", v)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-4">
            <span className="mr-1 flex items-center gap-1.5 text-sm font-medium">
              <Archive className="h-4 w-4 text-brand" />
              Export audit log
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting}
              onClick={() => void exportAudit("csv")}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting}
              onClick={() => void exportAudit("json")}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              JSON
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard title="Feature flags">
          {flagKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feature flags configured.</p>
          ) : (
            <div className="space-y-3">
              {flagKeys.map((flag) => (
                <Toggle
                  key={flag}
                  label={flag}
                  icon={<Flag className="h-4 w-4 text-brand" />}
                  checked={settings.feature_flags[flag]}
                  onChange={() => toggleFlag(flag)}
                />
              ))}
            </div>
          )}
        </SettingsCard>
      </div>
    </>
  );
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/** Whole-day retention input. Empty/blur coerces to 0 (= keep forever). */
function RetentionField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="relative">
        <Input
          type="number"
          min={0}
          max={3650}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => {
            const n = Math.max(0, Math.min(3650, Math.floor(Number(e.target.value) || 0)));
            onChange(n);
          }}
          className="pr-14"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          days
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground">
        {value === 0 ? "Kept forever" : `Pruned after ${value} day${value === 1 ? "" : "s"}`}
      </span>
    </label>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  icon,
  tone = "brand",
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon?: ReactNode;
  tone?: "brand" | "warning";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {icon ??
          (tone === "warning" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          ) : null)}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? (tone === "warning" ? "bg-warning" : "bg-brand") : "bg-secondary",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-sm transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
