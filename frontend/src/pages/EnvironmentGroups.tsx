// Environment Groups — the workspace-level page behind the sidebar entry, and
// the source of Part B's dynamic `Env Groups (X)` tab.
//
// A group is a reusable set of variables linked to environments: every resource
// deployed in a linked environment inherits them, and the resource's own
// variables win on a key clash. Secret values are write-only — the API returns
// `value: null` for them — so this page offers "replace", never "reveal".

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
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
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type {
  EnvGroupRow,
  EnvGroupTarget,
  EnvGroupVar,
  EnvGroupsPayload,
} from "@/lib/workspaceTypes";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A row in the variable editor. `keep` means "leave the stored secret alone". */
type DraftVar = {
  id?: string;
  key: string;
  value: string;
  is_secret: boolean;
  keep: boolean;
};

function toDraft(row: EnvGroupVar): DraftVar {
  return {
    id: row.id,
    key: row.key,
    value: row.value ?? "",
    is_secret: row.is_secret,
    // A secret arrives as null, so the only honest default is to keep it.
    keep: row.is_secret,
  };
}

/** First problem with the draft set, or null when it is safe to save. */
function draftProblem(rows: DraftVar[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.key.trim()) return "Every variable needs a key.";
    if (!KEY_RE.test(row.key)) {
      return `“${row.key}” is not a valid key — use letters, digits and underscores, starting with a letter or underscore.`;
    }
    if (seen.has(row.key)) return `“${row.key}” appears more than once.`;
    seen.add(row.key);
    if (!row.keep && !row.value) return `“${row.key}” has no value.`;
  }
  return null;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EnvironmentGroups() {
  const [data, setData] = useState<EnvGroupsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<EnvGroupsPayload>(scoped("/api/env-groups")));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[960px] space-y-4">
        <div className="h-8 w-56 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-28 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load environment groups."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[27px] font-medium leading-tight text-foreground">
          Environment Groups
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh environment groups"
            className="hover:bg-hover"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          {data.can_write ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New environment group
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Share one set of environment variables across services. Link a group to an environment and
        every resource in it inherits the variables; a variable set on the service itself always
        wins.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      <div className="mt-6">
        {data.groups.length === 0 ? (
          <EmptyGroups canWrite={data.can_write} onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="space-y-3">
            {data.groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                targets={data.targets}
                canWrite={data.can_write}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </div>

      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} onDone={load} />
    </div>
  );
}

function EmptyGroups({ canWrite, onCreate }: { canWrite: boolean; onCreate: () => void }) {
  return (
    <div className="rounded-md border border-border p-8 text-center">
      <Layers className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-2 text-[14px] text-foreground">No environment groups yet</p>
      <p className="mx-auto mt-1 max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
        Create a group for the values several services share — database URLs, API keys, feature
        flags — and link it to the environments that need them.
      </p>
      {canWrite ? (
        <Button className="mt-3" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New environment group
        </Button>
      ) : null}
    </div>
  );
}

/** One group: summary row, expandable variable editor and its environment links. */
function GroupCard({
  group,
  targets,
  canWrite,
  onChanged,
}: {
  group: EnvGroupRow;
  targets: EnvGroupTarget[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
          )}
          <span className="truncate text-[13px] font-medium text-foreground">{group.name}</span>
          <span className="text-[11px] text-muted-foreground">
            {group.var_count} variable{group.var_count === 1 ? "" : "s"}
            {group.secret_count > 0 ? ` · ${group.secret_count} secret` : ""}
            {" · "}
            {group.links.length === 0
              ? "not linked"
              : `linked to ${group.links.length} environment${group.links.length === 1 ? "" : "s"}`}
          </span>
        </button>
        {canWrite ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="bare"
              size="icon"
              aria-label={`Rename ${group.name}`}
              className="hover:bg-hover"
              onClick={() => setRenameOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="bare"
              size="icon"
              aria-label={`Delete ${group.name}`}
              className="text-muted-foreground hover:bg-hover hover:text-danger"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-border px-4 py-4">
          <VarEditor group={group} canWrite={canWrite} onChanged={onChanged} />
          <div className="mt-5 h-px w-full bg-border" />
          <LinkPanel
            group={group}
            targets={targets}
            canWrite={canWrite}
            onChanged={onChanged}
          />
        </div>
      ) : null}

      <RenameGroupDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        group={group}
        onDone={onChanged}
      />
      <DeleteGroupDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        group={group}
        onDone={onChanged}
      />
    </div>
  );
}

/**
 * The variable table. Saving replaces the whole set (PUT), which is what the
 * table means: what you see is what the group will contain. A kept secret is
 * sent back as `value: null` with its row id, so the plaintext never travels in
 * either direction.
 */
function VarEditor({
  group,
  canWrite,
  onChanged,
}: {
  group: EnvGroupRow;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<DraftVar[]>(() => group.vars.map(toDraft));
  const [saving, setSaving] = useState(false);

  // Re-sync when the server view changes (save, or another tab's edit).
  useEffect(() => {
    setRows(group.vars.map(toDraft));
  }, [group]);

  const patch = (index: number, next: Partial<DraftVar>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...next } : row)));
  };

  const problem = draftProblem(rows);
  // Save stays disabled until something actually differs from the server view.
  // A kept secret counts as unchanged; a replaced one only once it has text.
  const dirty =
    rows.length !== group.vars.length ||
    rows.some((row, index) => {
      const original = group.vars[index];
      if (!original || row.id !== original.id) return true;
      if (row.key !== original.key || row.is_secret !== original.is_secret) return true;
      if (row.keep) return false;
      return row.value !== (original.value ?? "");
    });

  const save = async () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      await apiSend(scoped(`/api/env-groups/${group.id}/vars`), "PUT", {
        vars: rows.map((row) => ({
          id: row.id,
          key: row.key,
          // null = keep what the server already has (a secret we never saw).
          value: row.keep ? null : row.value,
          is_secret: row.is_secret,
        })),
      });
      toast.success("Variables saved");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.09em] text-muted-foreground">
          Environment variables
        </p>
        <p className="text-[11px] text-muted-foreground">Updated {timeLabel(group.updated_at)}</p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 rounded-md border border-border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">
          This group is empty. Add a variable below.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row, index) => (
            <div key={row.id ?? `new-${index}`} className="flex flex-wrap items-center gap-2">
              <Input
                value={row.key}
                readOnly={!canWrite}
                aria-label="Key"
                placeholder="KEY"
                className="h-8 w-full font-mono text-[12px] sm:w-[220px]"
                onChange={(event) => patch(index, { key: event.target.value.trim() })}
              />
              {row.keep ? (
                <div className="flex h-8 flex-1 items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 text-[12px] text-muted-foreground">
                  <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                  <span className="font-mono">••••••••••••</span>
                  {canWrite ? (
                    <button
                      type="button"
                      className="ml-auto text-[11px] text-brand hover:underline"
                      onClick={() => patch(index, { keep: false, value: "" })}
                    >
                      Replace
                    </button>
                  ) : null}
                </div>
              ) : (
                <Input
                  value={row.value}
                  readOnly={!canWrite}
                  aria-label="Value"
                  placeholder="value"
                  className="h-8 flex-1 font-mono text-[12px]"
                  onChange={(event) => patch(index, { value: event.target.value })}
                />
              )}
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={row.is_secret}
                  disabled={!canWrite}
                  className="h-3.5 w-3.5 accent-[hsl(var(--brand))]"
                  onChange={(event) =>
                    patch(index, {
                      is_secret: event.target.checked,
                      // Un-secreting a stored value cannot reveal it, so the row
                      // has to be re-entered rather than silently exposed.
                      keep: event.target.checked ? row.keep : false,
                      value: event.target.checked ? row.value : row.keep ? "" : row.value,
                    })
                  }
                />
                Secret
              </label>
              {canWrite ? (
                <Button
                  variant="bare"
                  size="icon"
                  aria-label={`Remove ${row.key || "variable"}`}
                  className="text-muted-foreground hover:bg-hover hover:text-danger"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canWrite ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((current) => [...current, { key: "", value: "", is_secret: false, keep: false }])
            }
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add variable
          </Button>
          <Button size="sm" disabled={saving || !dirty || problem !== null} onClick={() => void save()}>
            {saving ? "Saving…" : "Save variables"}
          </Button>
          {problem ? <span className="text-[11px] text-danger">{problem}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Linked environments, plus the picker for adding one. */
function LinkPanel({
  group,
  targets,
  canWrite,
  onChanged,
}: {
  group: EnvGroupRow;
  targets: EnvGroupTarget[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  const linked = new Set(group.links.map((link) => link.environment_id));
  const available = targets
    .map((target) => ({
      ...target,
      environments: target.environments.filter((env) => !linked.has(env.id)),
    }))
    .filter((target) => target.environments.length > 0);

  const link = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await apiSend(scoped(`/api/env-groups/${group.id}/links`), "POST", {
        environment_id: choice,
      });
      toast.success("Environment linked");
      setChoice("");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (environmentId: string, label: string) => {
    setBusy(true);
    try {
      await apiSend(scoped(`/api/env-groups/${group.id}/links/${environmentId}`), "DELETE");
      toast.success(`Unlinked from ${label}`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <p className="text-[11px] uppercase tracking-[0.09em] text-muted-foreground">
        Linked environments
      </p>

      {group.links.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Not linked yet — these variables are not reaching any service.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {group.links.map((item) => (
            <span
              key={item.id}
              className="flex items-center gap-1.5 rounded-[3px] border border-border px-2 py-[3px] text-[11px] text-foreground"
            >
              {item.project_name} / {item.environment_name}
              {canWrite ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Unlink ${item.project_name} / ${item.environment_name}`}
                  className="text-muted-foreground hover:text-danger"
                  onClick={() =>
                    void unlink(
                      item.environment_id,
                      `${item.project_name} / ${item.environment_name}`,
                    )
                  }
                >
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}

      {canWrite ? (
        available.length === 0 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {targets.length === 0
              ? "No environments exist in this workspace yet."
              : "Every environment in this workspace is already linked."}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={choice}
              aria-label="Environment to link"
              className={cn(
                "h-8 rounded-md border border-border bg-card px-2 text-[12px] text-foreground",
                "focus:outline-none focus:ring-1 focus:ring-[hsl(var(--brand-ring))]",
              )}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">Select an environment…</option>
              {available.map((target) => (
                <optgroup key={target.project_id} label={target.project_name}>
                  {target.environments.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Button variant="outline" size="sm" disabled={!choice || busy} onClick={() => void link()}>
              Link environment
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await apiSend(scoped("/api/env-groups"), "POST", { name: name.trim() });
      toast.success("Environment group created");
      setName("");
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
        <DialogHeader>
          <DialogTitle>New environment group</DialogTitle>
          <DialogDescription>
            Name the group, then add variables and link it to the environments that need them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <label className="text-[12px] text-muted-foreground" htmlFor="env-group-name">
            Name
          </label>
          <Input
            id="env-group-name"
            value={name}
            autoFocus
            placeholder="shared-secrets"
            className="mt-1.5 h-9 text-[13px]"
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameGroupDialog({
  open,
  onOpenChange,
  group,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: EnvGroupRow;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(group.name);
  }, [open, group.name]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await apiSend(scoped(`/api/env-groups/${group.id}`), "PATCH", { name: name.trim() });
      toast.success("Group renamed");
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
        <DialogHeader>
          <DialogTitle>Rename environment group</DialogTitle>
          <DialogDescription>
            Renaming does not change any variable or link — only the label.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <Input
            value={name}
            autoFocus
            aria-label="Group name"
            className="h-9 text-[13px]"
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || name.trim() === group.name}>
              {saving ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Destructive, so it is confirmed (§77) and states what deploys will lose. */
function DeleteGroupDialog({
  open,
  onOpenChange,
  group,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: EnvGroupRow;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await apiSend(scoped(`/api/env-groups/${group.id}`), "DELETE");
      toast.success("Environment group deleted");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete environment group</DialogTitle>
          <DialogDescription>
            <span className="text-foreground">{group.name}</span> and its {group.var_count} variable
            {group.var_count === 1 ? "" : "s"} are removed, along with{" "}
            {group.links.length === 0
              ? "no environment links"
              : `${group.links.length} environment link${group.links.length === 1 ? "" : "s"}`}
            . Running containers keep the values they already have until their next deploy. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
