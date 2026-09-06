// Blueprints — the Part A sidebar entry under Projects.
//
// A blueprint is this workspace's infrastructure-as-code: a spec listing the
// services and managed databases a project needs, applied into a project group
// and environment the user picks. Applying it walks the same creation paths as
// the New Project / New Database flows, so quotas and validation are identical.
//
// Nothing here pretends. The parsed summary comes from the server's own parser,
// a spec that no longer parses shows its errors instead of a resource count, and
// an apply reports `partial` with the per-item log rather than a blanket success.
// Created services are cloned but not deployed — the run log says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  GitBranch,
  Layers,
  Play,
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
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type {
  BlueprintApplyRow,
  BlueprintRow,
  BlueprintSpecFormat,
  BlueprintTarget,
  BlueprintValidation,
  BlueprintsPayload,
} from "@/lib/workspaceTypes";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring";

function timeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Colour only — the words are the server's. */
function runClass(status: string): string {
  if (status === "succeeded") return "border-success-border bg-success-surface text-success";
  if (status === "failed") return "border-danger-border bg-danger-surface text-danger";
  if (status === "partial") return "border-warning-border bg-warning-surface text-warning";
  return "border-border text-muted-foreground";
}

export default function Blueprints() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<BlueprintsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<BlueprintsPayload>(scoped("/api/blueprints")));
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

  // `+ New → New Blueprint` from any page lands here with `?new=1`.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[960px] space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-32 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load blueprints."}
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
        <h1 className="text-[27px] font-medium leading-tight text-foreground">Blueprints</h1>
        <div className="flex items-center gap-1.5">
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh blueprints"
            className="hover:bg-hover"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          {data.can_write ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={2} />
              New Blueprint
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Declare the services and databases {data.workspace.name} needs in one spec, then apply it to
        create them. Available on every plan.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      <div className="mt-6 space-y-3">
        {data.blueprints.length === 0 ? (
          <EmptyBlueprints canWrite={data.can_write} onAdd={() => setCreateOpen(true)} />
        ) : (
          data.blueprints.map((blueprint) => (
            <BlueprintCard
              key={blueprint.id}
              blueprint={blueprint}
              targets={data.targets}
              canWrite={data.can_write}
              onChanged={load}
            />
          ))
        )}
      </div>

      <HowItWorks />

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        exampleSpec={data.example_spec}
        formats={data.spec_formats}
        onDone={load}
      />
    </div>
  );
}

function EmptyBlueprints({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  return (
    <div className="rounded-md border border-border p-8 text-center">
      <Layers className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-2 text-[14px] text-foreground">No blueprints yet</p>
      <p className="mx-auto mt-1 max-w-[460px] text-[12px] leading-relaxed text-muted-foreground">
        Write a spec listing your services and databases — or point at a{" "}
        <span className="font-mono text-[11px]">godhosting.yaml</span> in a repository — and apply it
        to stand the whole stack up at once.
      </p>
      {canWrite ? (
        <Button variant="outline" size="sm" className="mt-3.5" onClick={onAdd}>
          <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={2} />
          New Blueprint
        </Button>
      ) : null}
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <h2 className="text-[13px] font-medium text-foreground">How an apply works</h2>
      <ol className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
        <li>
          1. The spec is parsed strictly. An unknown key or a bad value is an error, never a guessed
          default — so nothing is created from a spec you did not write.
        </li>
        <li>
          2. You choose the project and environment. Every resource is created there, counting
          against the same plan limits as creating it by hand.
        </li>
        <li>
          3. A name that already exists in that project is skipped, not overwritten. Re-applying is
          safe.
        </li>
        <li>
          4. Services are created and their repository cloned, but not deployed — open a service and
          deploy it when you are ready. Databases are provisioned immediately.
        </li>
      </ol>
    </section>
  );
}

function BlueprintCard({
  blueprint,
  targets,
  canWrite,
  onChanged,
}: {
  blueprint: BlueprintRow;
  targets: BlueprintTarget[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState<"sync" | "delete" | null>(null);

  const { services, databases, errors } = blueprint.summary;
  const broken = errors.length > 0;
  const latest = blueprint.applies[0] ?? null;

  const sync = async () => {
    setBusy("sync");
    try {
      await apiSend(scoped(`/api/blueprints/${blueprint.id}/sync`), "POST");
      toast.success(`${blueprint.name} synced`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
      // The row records why it is stale, so refresh either way.
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await apiSend(scoped(`/api/blueprints/${blueprint.id}`), "DELETE");
      toast.success(`${blueprint.name} deleted`);
      setDeleteOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />
            <p className="truncate text-[14px] text-foreground">{blueprint.name}</p>
            <span className="rounded-[3px] border border-border px-1.5 py-[1px] text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {blueprint.source === "repo" ? "repo" : "manual"}
            </span>
          </div>
          {blueprint.description ? (
            <p className="mt-1 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
              {blueprint.description}
            </p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-subtle">
            {broken ? (
              <span className="text-danger">Spec has {errors.length} error(s)</span>
            ) : (
              <>
                {services.length} service{services.length === 1 ? "" : "s"} · {databases.length}{" "}
                database{databases.length === 1 ? "" : "s"}
              </>
            )}
            {" · "}
            {blueprint.source === "repo" && blueprint.spec_path ? (
              <>
                <span className="font-mono">{blueprint.spec_path}</span>
                {blueprint.repo_branch ? ` @ ${blueprint.repo_branch}` : ""} · synced{" "}
                {timeLabel(blueprint.last_synced_at)}
              </>
            ) : (
              <>updated {timeLabel(blueprint.updated_at ?? blueprint.created_at)}</>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="bare" size="sm" className="hover:bg-hover" onClick={() => setOpen((v) => !v)}>
            {open ? (
              <ChevronDown className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronRight className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            )}
            Details
          </Button>
          {canWrite ? (
            <>
              {blueprint.repo_url ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void sync()}
                >
                  {busy === "sync" ? "Syncing…" : "Sync"}
                </Button>
              ) : null}
              <Button size="sm" disabled={broken} onClick={() => setApplyOpen(true)}>
                <Play className="mr-1 h-3 w-3" strokeWidth={2} aria-hidden />
                Apply
              </Button>
              <Button
                variant="bare"
                size="icon"
                aria-label={`Delete ${blueprint.name}`}
                className="hover:bg-hover"
                disabled={busy !== null}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-subtle">Read only</span>
          )}
        </div>
      </div>

      {blueprint.last_sync_error ? (
        <div className="mx-4 mb-4 flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-2.5 text-[11px] leading-relaxed text-warning">
          <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
          <span>Last sync: {blueprint.last_sync_error}</span>
        </div>
      ) : null}

      {broken ? (
        <div className="mx-4 mb-4 rounded-md border border-danger-border bg-danger-surface p-2.5">
          <p className="text-[11px] font-medium text-danger">
            This spec cannot be applied until it parses:
          </p>
          <ul className="mt-1 space-y-0.5">
            {errors.slice(0, 6).map((message) => (
              <li key={message} className="text-[11px] leading-relaxed text-danger">
                • {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {latest ? (
        <div className="border-t border-border px-4 py-2.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
              runClass(latest.status),
            )}
          >
            {latest.status === "succeeded" ? (
              <CheckCircle2 className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            ) : (
              <AlertTriangle className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            )}
            Last apply {latest.status}
          </span>
          <span className="ml-2 text-[11px] text-subtle">
            {latest.created_count} created · {latest.skipped_count} skipped ·{" "}
            {latest.failed_count} failed · {timeLabel(latest.created_at)}
          </span>
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-border p-4">
          <SpecBreakdown blueprint={blueprint} />
          <RunHistory applies={blueprint.applies} />
        </div>
      ) : null}

      <ApplyDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        blueprint={blueprint}
        targets={targets}
        onDone={onChanged}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {blueprint.name}?</DialogTitle>
            <DialogDescription>
              The spec and its apply history are removed. Resources it already created are{" "}
              <span className="text-foreground">not</span> deleted — they keep running and must be
              removed individually.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "delete" ? "Deleting…" : "Delete blueprint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** What the spec declares, straight from the server's parse of it. */
function SpecBreakdown({ blueprint }: { blueprint: BlueprintRow }) {
  const [showSpec, setShowSpec] = useState(false);
  const { services, databases } = blueprint.summary;

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">Services</p>
          {services.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-subtle">None declared</p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {services.map((service) => (
                <li key={service.name} className="text-[12px] text-foreground">
                  {service.name}
                  <span className="ml-1.5 rounded-[3px] border border-border px-1 py-[1px] text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {service.type}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
                    <GitBranch className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                    <span className="truncate font-mono">{service.repo}</span>
                    {service.branch ? <span>@ {service.branch}</span> : null}
                  </span>
                  <span className="text-[11px] text-subtle">
                    port {service.port} · {service.env_count} env var
                    {service.env_count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">Databases</p>
          {databases.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-subtle">None declared</p>
          ) : (
            <ul className="mt-1.5 space-y-1.5">
              {databases.map((database) => (
                <li key={database.name} className="text-[12px] text-foreground">
                  <span className="flex items-center gap-1.5">
                    <Database className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    {database.name}
                  </span>
                  <span className="text-[11px] text-subtle">
                    {database.engine}
                    {database.version ? ` ${database.version}` : " (recommended version)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowSpec((v) => !v)}
        className="mt-3.5 rounded-[3px] text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
      >
        {showSpec ? "Hide spec" : `Show spec (${blueprint.spec_format})`}
      </button>
      {showSpec ? (
        <pre className="mt-2 max-h-[320px] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {blueprint.spec}
        </pre>
      ) : null}
    </div>
  );
}

function RunHistory({ applies }: { applies: BlueprintApplyRow[] }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  if (applies.length === 0) {
    return (
      <p className="mt-4 border-t border-border pt-3 text-[11px] text-subtle">
        Never applied. Nothing has been created from this blueprint yet.
      </p>
    );
  }
  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">Apply history</p>
      <ul className="mt-1.5 space-y-1.5">
        {applies.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => setOpenRun((v) => (v === run.id ? null : run.id))}
              className="flex w-full items-center gap-2 rounded-[3px] px-1 py-1 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
            >
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-[3px] border px-1.5 py-[1px] text-[10px] uppercase tracking-[0.08em]",
                  runClass(run.status),
                )}
              >
                {run.status}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {run.created_count} created · {run.skipped_count} skipped · {run.failed_count} failed
              </span>
              <span className="ml-auto text-[11px] text-subtle">{timeLabel(run.created_at)}</span>
            </button>
            {openRun === run.id ? (
              <pre className="mt-1 max-h-[240px] overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {run.log?.trim() || run.error || "No log was recorded for this run."}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Apply a blueprint. The target list is the workspace's real projects and
 * environments — there is no id to type and nothing from another tenant to paste.
 */
function ApplyDialog({
  open,
  onOpenChange,
  blueprint,
  targets,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blueprint: BlueprintRow;
  targets: BlueprintTarget[];
  onDone: () => Promise<void>;
}) {
  const NEW_PROJECT = "__new__";
  const [projectId, setProjectId] = useState(NEW_PROJECT);
  const [environmentId, setEnvironmentId] = useState("");
  const [newName, setNewName] = useState(blueprint.name);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BlueprintApplyRow | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = targets[0];
    setProjectId(first ? first.project_id : NEW_PROJECT);
    setEnvironmentId(first?.environments[0]?.id ?? "");
    setNewName(blueprint.name);
    setResult(null);
  }, [open, targets, blueprint.name]);

  const chosen = useMemo(
    () => targets.find((t) => t.project_id === projectId) ?? null,
    [targets, projectId],
  );

  const pickProject = (id: string) => {
    setProjectId(id);
    const next = targets.find((t) => t.project_id === id);
    setEnvironmentId(next?.environments[0]?.id ?? "");
  };

  const { services, databases } = blueprint.summary;
  const total = services.length + databases.length;
  const blocked = running || (projectId === NEW_PROJECT && !newName.trim());

  const run = async () => {
    if (blocked) return;
    setRunning(true);
    try {
      const res = await apiSend<{ apply: BlueprintApplyRow }>(
        scoped(`/api/blueprints/${blueprint.id}/apply`),
        "POST",
        projectId === NEW_PROJECT
          ? { new_project_name: newName.trim() }
          : { project_id: projectId, environment_id: environmentId },
      );
      setResult(res.apply);
      // The status is the truth, not the HTTP code.
      if (res.apply.status === "succeeded") {
        toast.success(`${res.apply.created_count} resource(s) created`);
      } else if (res.apply.status === "partial") {
        toast.warning(
          `${res.apply.created_count} created, ${res.apply.failed_count} failed — see the log`,
        );
      } else {
        toast.error(res.apply.error ?? "The apply failed — see the log");
      }
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply {blueprint.name}</DialogTitle>
          <DialogDescription>
            {total} resource{total === 1 ? "" : "s"} will be created — {services.length} service
            {services.length === 1 ? "" : "s"} and {databases.length} database
            {databases.length === 1 ? "" : "s"}. Names that already exist are skipped.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-2">
            <span
              className={cn(
                "inline-flex items-center rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
                runClass(result.status),
              )}
            >
              {result.status}
            </span>
            <p className="text-[12px] text-muted-foreground">
              {result.created_count} created · {result.skipped_count} skipped ·{" "}
              {result.failed_count} failed
            </p>
            <pre className="max-h-[280px] overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {result.log?.trim() || result.error || "No log was recorded."}
            </pre>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="bp-project" className="text-[12px] text-muted-foreground">
                Project
              </label>
              <select
                id="bp-project"
                value={projectId}
                onChange={(e) => pickProject(e.target.value)}
                className={SELECT_CLASS}
              >
                {targets.map((target) => (
                  <option key={target.project_id} value={target.project_id} className="bg-card">
                    {target.project_name}
                  </option>
                ))}
                <option value={NEW_PROJECT} className="bg-card">
                  Create a new project…
                </option>
              </select>
            </div>

            {projectId === NEW_PROJECT ? (
              <div className="space-y-1.5">
                <label htmlFor="bp-new-project" className="text-[12px] text-muted-foreground">
                  New project name
                </label>
                <Input
                  id="bp-new-project"
                  value={newName}
                  maxLength={120}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <p className="text-[11px] text-subtle">
                  It gets a Production environment, and everything is created there.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor="bp-environment" className="text-[12px] text-muted-foreground">
                  Environment
                </label>
                <select
                  id="bp-environment"
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {(chosen?.environments ?? []).map((environment) => (
                    <option key={environment.id} value={environment.id} className="bg-card">
                      {environment.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-subtle">
              Services are created and cloned but not deployed. Databases are provisioned right
              away, so Docker must be running for them to succeed.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {result ? null : (
            <Button disabled={blocked} onClick={() => void run()}>
              {running ? "Applying…" : `Apply ${total} resource${total === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create a blueprint, either by writing the spec or by pointing at a repo file. */
function CreateDialog({
  open,
  onOpenChange,
  exampleSpec,
  formats,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exampleSpec: string;
  formats: BlueprintSpecFormat[];
  onDone: () => Promise<void>;
}) {
  const [source, setSource] = useState<"manual" | "repo">("manual");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<BlueprintSpecFormat>(formats[0] ?? "yaml");
  const [spec, setSpec] = useState(exampleSpec);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [specPath, setSpecPath] = useState("godhosting.yaml");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<BlueprintValidation | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource("manual");
    setName("");
    setDescription("");
    setFormat(formats[0] ?? "yaml");
    setSpec(exampleSpec);
    setRepoUrl("");
    setBranch("");
    setSpecPath("godhosting.yaml");
    setCheck(null);
  }, [open, exampleSpec, formats]);

  const validate = async () => {
    setChecking(true);
    try {
      setCheck(
        await apiSend<BlueprintValidation>(scoped("/api/blueprints/validate"), "POST", {
          spec,
          spec_format: format,
        }),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const trimmedName = name.trim();
  const blocked =
    saving ||
    !trimmedName ||
    trimmedName.length > 60 ||
    (source === "manual" ? !spec.trim() : !repoUrl.trim());

  const submit = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      await apiSend(scoped("/api/blueprints"), "POST", {
        name: trimmedName,
        description: description.trim() || undefined,
        source,
        spec_format: format,
        ...(source === "manual"
          ? { spec }
          : {
              repo_url: repoUrl.trim(),
              repo_branch: branch.trim() || undefined,
              spec_path: specPath.trim() || "godhosting.yaml",
            }),
      });
      toast.success(`${trimmedName} saved`);
      onOpenChange(false);
      await onDone();
    } catch (err) {
      // Includes the parser's own first error, so the user knows what to fix.
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>New Blueprint</DialogTitle>
          <DialogDescription>
            Write the spec here, or read it from a file in a Git repository so the repo stays the
            source of truth.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="bp-name" className="text-[12px] text-muted-foreground">
                Name
              </label>
              <Input
                id="bp-name"
                value={name}
                maxLength={60}
                placeholder="Production stack"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="bp-source" className="text-[12px] text-muted-foreground">
                Spec source
              </label>
              <select
                id="bp-source"
                value={source}
                onChange={(e) => setSource(e.target.value as "manual" | "repo")}
                className={SELECT_CLASS}
              >
                <option value="manual" className="bg-card">
                  Write it here
                </option>
                <option value="repo" className="bg-card">
                  Read from a repository
                </option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bp-description" className="text-[12px] text-muted-foreground">
              Description (optional)
            </label>
            <Input
              id="bp-description"
              value={description}
              maxLength={240}
              placeholder="API, worker and Postgres"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {source === "repo" ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="bp-repo" className="text-[12px] text-muted-foreground">
                  Repository URL
                </label>
                <Input
                  id="bp-repo"
                  value={repoUrl}
                  placeholder="https://github.com/acme/infra.git"
                  onChange={(e) => setRepoUrl(e.target.value)}
                />
                <p className="text-[11px] text-subtle">
                  Must be reachable without credentials — the file is read from a shallow clone.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="bp-branch" className="text-[12px] text-muted-foreground">
                    Branch (optional)
                  </label>
                  <Input
                    id="bp-branch"
                    value={branch}
                    placeholder="main"
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="bp-path" className="text-[12px] text-muted-foreground">
                    Spec path
                  </label>
                  <Input
                    id="bp-path"
                    value={specPath}
                    onChange={(e) => setSpecPath(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="bp-spec" className="text-[12px] text-muted-foreground">
                  Spec
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    aria-label="Spec format"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as BlueprintSpecFormat)}
                    className="h-7 rounded-md border border-border bg-transparent px-1.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
                  >
                    {formats.map((f) => (
                      <option key={f} value={f} className="bg-card">
                        {f}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checking || !spec.trim()}
                    onClick={() => void validate()}
                  >
                    {checking ? "Checking…" : "Check spec"}
                  </Button>
                </div>
              </div>
              <textarea
                id="bp-spec"
                value={spec}
                spellCheck={false}
                rows={14}
                onChange={(e) => {
                  setSpec(e.target.value);
                  setCheck(null);
                }}
                className="w-full rounded-md border border-border bg-transparent p-2.5 font-mono text-[11px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
              />
              {check ? (
                check.ok ? (
                  <p className="flex items-start gap-1.5 text-[11px] text-success">
                    <CheckCircle2 className="mt-[1px] h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
                    Parses cleanly — {check.services.length} service
                    {check.services.length === 1 ? "" : "s"}, {check.databases.length} database
                    {check.databases.length === 1 ? "" : "s"}.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {check.errors.slice(0, 6).map((message) => (
                      <li key={message} className="text-[11px] leading-relaxed text-danger">
                        • {message}
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={blocked} onClick={() => void submit()}>
            {saving ? "Saving…" : "Save blueprint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
