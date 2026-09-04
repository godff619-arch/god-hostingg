// Admin → Feature Flags (/admin/feature-flags) — the platform's capability switches.
//
// Every switch on this page is enforced by real server-side code; the backend owns
// the registry and sends `enforcedAt` with each one, which this page prints so the
// claim is auditable rather than taken on trust. A flag with nothing behind it
// cannot appear here, because it would not be in the registry.
//
// Two behaviours are worth stating plainly on the page itself, because both are
// easy to assume the other way round: a disabled flag applies to administrators
// too (these are "does this platform offer X", not permissions), and nothing that
// already exists is hidden or deleted — only new use is refused.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  ToggleLeft,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { FeatureFlagDef, FeatureFlagsResponse } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

type Flags = Record<string, boolean>;

export default function AdminFeatureFlags() {
  const [defs, setDefs] = useState<FeatureFlagDef[]>([]);
  /** Last known server state — the baseline every dirty check is made against. */
  const [saved, setSaved] = useState<Flags>({});
  const [draft, setDraft] = useState<Flags>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminGet<FeatureFlagsResponse>("/feature-flags");
      setDefs(data.definitions ?? []);
      setSaved(data.flags ?? {});
      setDraft(data.flags ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load feature flags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only the keys that actually moved are sent, so a save never rewrites a flag
  // another operator changed in the meantime.
  const changed = useMemo(
    () => defs.map((d) => d.key).filter((key) => draft[key] !== saved[key]),
    [defs, draft, saved],
  );

  const disabledCount = useMemo(
    () => defs.filter((d) => draft[d.key] === false).length,
    [defs, draft],
  );

  const groups = useMemo(() => {
    const byGroup = new Map<string, FeatureFlagDef[]>();
    for (const def of defs) {
      const list = byGroup.get(def.group);
      if (list) list.push(def);
      else byGroup.set(def.group, [def]);
    }
    return [...byGroup.entries()];
  }, [defs]);

  const save = async () => {
    if (!changed.length) return;
    setSaving(true);
    try {
      const patch: Flags = {};
      for (const key of changed) patch[key] = draft[key];
      const res = await adminSend<FeatureFlagsResponse>("/feature-flags", "PATCH", {
        flags: patch,
      });
      setDefs(res.definitions ?? defs);
      setSaved(res.flags);
      setDraft(res.flags);
      const off = defs
        .filter((d) => changed.includes(d.key) && !res.flags[d.key])
        .map((d) => d.label);
      toast.success(
        off.length
          ? `Saved — ${off.join(", ")} now disabled platform-wide`
          : `Saved — ${changed.length} feature${changed.length === 1 ? "" : "s"} updated`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save feature flags");
    } finally {
      setSaving(false);
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

  if (error) {
    return (
      <div className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-16 text-center">
        <p className="text-sm text-danger">{error}</p>
        <Button variant="outline" className="mt-4" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Feature Flags"
        description="Turn platform capabilities on or off. Each switch is enforced by the API, not just hidden in the dashboard."
        icon={ToggleLeft}
        meta={
          <>
            <StatChip label="Features" value={defs.length} />
            <StatChip
              label="Disabled"
              value={disabledCount}
              tone={disabledCount ? "warning" : "success"}
            />
            {changed.length > 0 && (
              <StatChip label="Unsaved" value={changed.length} tone="info" />
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              className="h-10"
              disabled={!changed.length || saving}
              onClick={() => setDraft(saved)}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            <Button onClick={() => void save()} disabled={!changed.length || saving} className="h-10">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </>
        }
      />

      <ScopeNotice disabledCount={disabledCount} />

      <div className="space-y-4">
        {groups.map(([group, items]) => (
          <section
            key={group}
            className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm"
          >
            <h2 className="mb-1 text-base font-semibold">{group}</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              {items.filter((d) => draft[d.key] !== false).length} of {items.length} enabled
            </p>
            <div className="divide-y divide-border/50">
              {items.map((def) => (
                <FlagRow
                  key={def.key}
                  def={def}
                  checked={draft[def.key] !== false}
                  dirty={draft[def.key] !== saved[def.key]}
                  onChange={(value) => setDraft((prev) => ({ ...prev, [def.key]: value }))}
                />
              ))}
            </div>
          </section>
        ))}

        {groups.length === 0 && (
          <div className="rounded-2xl border border-border/60 bg-card px-4 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              This build registers no feature flags.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The two rules an operator would otherwise have to discover by surprise. Shown
 * always — the reassuring half ("nothing is hidden") matters most at the moment
 * someone is about to switch a feature off for a live platform.
 */
function ScopeNotice({ disabledCount }: { disabledCount: number }) {
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3",
        disabledCount
          ? "border-warning-border bg-warning-surface"
          : "border-border/60 bg-secondary/30",
      )}
    >
      {disabledCount ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      )}
      <div className="min-w-0 text-xs leading-relaxed">
        {disabledCount > 0 ? (
          <p className="font-medium text-warning">
            {disabledCount} feature{disabledCount === 1 ? " is" : "s are"} switched off for
            everyone on this platform, administrators included.
          </p>
        ) : (
          <p className="font-medium text-foreground">Every feature is enabled.</p>
        )}
        <p className="mt-1 text-muted-foreground">
          Switching a feature off refuses new use of it and never hides or deletes what
          already exists — running services, live domains and existing databases carry on.
          Backup restore is never gated, so a flag can't lock you out of recovery.
        </p>
      </div>
    </div>
  );
}

function FlagRow({
  def,
  checked,
  dirty,
  onChange,
}: {
  def: FeatureFlagDef;
  checked: boolean;
  dirty: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{def.label}</p>
          {!checked && (
            <span className="rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
              Off
            </span>
          )}
          {dirty && (
            <span className="rounded-md border border-brand/25 bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
              Unsaved
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{def.description}</p>
        {/* The enforcement point, verbatim from the server, so "does this actually
            do anything?" is answerable without reading the source. */}
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Check className="h-3 w-3 shrink-0 text-success" />
          Enforced at
          <code className="rounded bg-secondary/60 px-1 py-0.5 font-mono text-[10px] text-foreground">
            {def.enforcedAt}
          </code>
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={def.label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand" : "bg-secondary",
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
