// Project settings, at `/projects/:projectId/settings` — the rail's `MANAGE → ⚙
// Settings` entry. Four sections: General (name, description), Environments,
// Access, and the Danger Zone.
//
// This page is about the *project group*, never about a service: a service's own
// settings live on its detail page. Deleting refuses while resources still live in
// the project (the server returns 409 `NOT_EMPTY`), which is surfaced verbatim
// rather than hidden behind a generic failure.
//
// Access is deliberately read-only here. Membership is held at the workspace
// level in this data model, so the page reports who can reach the project and
// links to the one place that can change it — it does not invent per-project roles.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Layers, Trash2 } from "lucide-react";
import { useBreadcrumbLeaf } from "@/components/shell/ShellContext";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { environmentPath, projectPath, projectsPath } from "@/lib/hierarchy";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import type { EnvironmentRow, MemberRow, ProjectOverviewPayload } from "@/lib/workspaceTypes";

export default function ProjectSettings() {
  const { projectId = "" } = useParams();
  const id = projectId;
  const navigate = useNavigate();
  const { canWrite, refresh: refreshWorkspace } = useWorkspace();
  const [data, setData] = useState<ProjectOverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useBreadcrumbLeaf(data?.project.name);

  const load = useCallback(async () => {
    try {
      const payload = await apiGet<ProjectOverviewPayload>(
        scoped(`/api/workspace/projects/${encodeURIComponent(id)}`),
      );
      setData(payload);
      setName(payload.project.name);
      setDescription(payload.project.description ?? "");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await apiSend(scoped(`/api/workspace/projects/${encodeURIComponent(id)}`), "PATCH", {
        name: trimmed,
        description: description.trim() || null,
      });
      toast.success("Project updated");
      await load();
      await refreshWorkspace();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error}
        </div>
        <Link
          to={projectsPath}
          className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Back to Projects
        </Link>
      </div>
    );
  }

  const resourceCount = data?.resources.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <div className="text-[10px] font-medium uppercase tracking-[0.11em] text-subtle">
        Project
      </div>
      <h1 className="mt-1 text-[27px] font-medium leading-tight text-foreground">Settings</h1>
      <div className="mt-5 h-px w-full bg-border" />

      <h2 className="mt-6 text-[15px] font-medium text-foreground">General</h2>
      <form onSubmit={save} className="mt-3 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="ps-name" className="text-[12px] text-muted-foreground">
            Project Name
          </label>
          <Input
            id="ps-name"
            value={name}
            maxLength={60}
            disabled={!data || !canWrite}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ps-desc" className="text-[12px] text-muted-foreground">
            Project Description
          </label>
          <textarea
            id="ps-desc"
            value={description}
            maxLength={280}
            rows={3}
            disabled={!data || !canWrite}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional"
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none placeholder:text-subtle focus:border-brand-ring disabled:opacity-60"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving || !name.trim() || !canWrite}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(projectPath(id))}>
            Back to overview
          </Button>
        </div>
      </form>

      <EnvironmentsSection
        projectId={id}
        environments={data?.environments ?? null}
        canWrite={canWrite}
        onChanged={() => void load()}
      />

      <AccessSection workspaceName={data?.workspace.name ?? null} />

      <div className="mt-10 rounded-md border border-danger-border p-4">
        <h2 className="text-[15px] font-medium text-foreground">Delete this project</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {resourceCount > 0
            ? `This project still holds ${resourceCount} resource${resourceCount === 1 ? "" : "s"}. Delete or move them first.`
            : "The project and its environments are removed. This cannot be undone."}
        </p>
        <Button
          type="button"
          variant="destructive"
          className="mt-3"
          disabled={!canWrite || resourceCount > 0}
          onClick={() => setConfirmOpen(true)}
        >
          Delete project
        </Button>
      </div>

      <ConfirmDeleteProject
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        projectId={id}
        projectName={data?.project.name ?? ""}
        onDeleted={() => {
          void refreshWorkspace();
          navigate(projectsPath);
        }}
      />
    </div>
  );
}

/** Typing the exact project name is required, per the destructive-action rule. */
function ConfirmDeleteProject({
  open,
  onOpenChange,
  projectId,
  projectName,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const remove = async () => {
    setSaving(true);
    try {
      await apiSend(scoped(`/api/workspace/projects/${encodeURIComponent(projectId)}`), "DELETE");
      toast.success(`Project “${projectName}” deleted`);
      onOpenChange(false);
      onDeleted();
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
          <DialogTitle>Delete “{projectName}”?</DialogTitle>
          <DialogDescription>
            Type the project name to confirm. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={typed}
          autoFocus
          placeholder={projectName}
          onChange={(event) => setTyped(event.target.value)}
        />
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={saving || typed !== projectName}
            onClick={() => void remove()}
          >
            {saving ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The project's environments. The list is the same one the overview renders, so it
 * is passed down rather than re-fetched; `onChanged` re-reads the project after a
 * create or delete so both views stay in step.
 *
 * An environment can only be removed once it is empty — the server enforces that,
 * and the button stays disabled until the count reaches zero so the refusal is not
 * a surprise. The default environment cannot be removed at all.
 */
function EnvironmentsSection({
  projectId,
  environments,
  canWrite,
  onChanged,
}: {
  projectId: string;
  environments: EnvironmentRow[] | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<EnvironmentRow | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      await apiSend(
        scoped(`/api/workspace/projects/${encodeURIComponent(projectId)}/environments`),
        "POST",
        { name: trimmed },
      );
      toast.success(`Environment “${trimmed}” created`);
      setName("");
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-[15px] font-medium text-foreground">Environments</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Each environment holds its own services and databases. Every project keeps one
        default environment.
      </p>

      <div className="mt-3 overflow-hidden rounded-md border border-border">
        {environments === null ? (
          <div className="space-y-px">
            {[0, 1].map((row) => (
              <div key={row} className="h-11 animate-pulse bg-secondary/50" />
            ))}
          </div>
        ) : environments.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            No environments yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {environments.map((environment) => (
              <li key={environment.id} className="flex items-center gap-3 px-3 py-2.5">
                <Layers className="h-3.5 w-3.5 shrink-0 text-subtle" strokeWidth={1.75} />
                <Link
                  to={environmentPath(projectId, environment.id)}
                  className="min-w-0 flex-1 truncate text-[13px] text-foreground hover:underline"
                >
                  {environment.name}
                </Link>
                {environment.is_default ? (
                  <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.08em] text-subtle">
                    Default
                  </span>
                ) : null}
                <span className="w-[92px] shrink-0 text-right text-[12px] text-muted-foreground">
                  {environment.counts.all} resource{environment.counts.all === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${environment.name}`}
                  disabled={!canWrite || environment.is_default || environment.counts.all > 0}
                  onClick={() => setPending(environment)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger-surface hover:text-danger disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={create} className="mt-3 flex items-center gap-2">
        <Input
          value={name}
          maxLength={40}
          disabled={!canWrite}
          placeholder="Staging"
          onChange={(event) => setName(event.target.value)}
          className="max-w-[240px]"
        />
        <Button type="submit" variant="outline" disabled={creating || !name.trim() || !canWrite}>
          {creating ? "Adding…" : "Add environment"}
        </Button>
      </form>

      <ConfirmDeleteEnvironment
        environment={pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onDeleted={() => {
          setPending(null);
          onChanged();
        }}
      />
    </section>
  );
}

/** Removing an environment is destructive, so it asks first (§39). */
function ConfirmDeleteEnvironment({
  environment,
  onOpenChange,
  onDeleted,
}: {
  environment: EnvironmentRow | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = async () => {
    if (!environment) return;
    setSaving(true);
    try {
      await apiSend(
        scoped(`/api/workspace/environments/${encodeURIComponent(environment.id)}`),
        "DELETE",
      );
      toast.success(`Environment “${environment.name}” deleted`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(environment)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{environment?.name}”?</DialogTitle>
          <DialogDescription>
            The environment is empty, so nothing is deployed. This cannot be undone.
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
            {saving ? "Deleting…" : "Delete environment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who can reach this project. Membership lives on the workspace in this data
 * model, so the list is the workspace's and the section says so plainly instead of
 * offering per-project roles that the backend would ignore. Changes happen in
 * workspace settings, which is one link away.
 */
function AccessSection({ workspaceName }: { workspaceName: string | null }) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const payload = await apiGet<{ members: MemberRow[] }>(scoped("/api/workspace/members"));
      setMembers(payload.members);
    } catch {
      setMembers(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-10">
      <h2 className="text-[15px] font-medium text-foreground">Access</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Everyone in {workspaceName ? `“${workspaceName}”` : "this workspace"} can reach this
        project. Roles are managed for the whole workspace.
      </p>

      <div className="mt-3 overflow-hidden rounded-md border border-border">
        {failed ? (
          <div className="flex items-center justify-between gap-3 px-3 py-4">
            <span className="text-[12px] text-muted-foreground">Could not load members.</span>
            <Button type="button" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : members === null ? (
          <div className="space-y-px">
            {[0, 1].map((row) => (
              <div key={row} className="h-11 animate-pulse bg-secondary/50" />
            ))}
          </div>
        ) : members.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            No members yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 px-3 py-2.5">
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-medium text-brand-foreground"
                >
                  {(member.name?.trim()[0] || member.email.trim()[0] || "U").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">
                    {member.name?.trim() || member.email}
                  </span>
                  {member.name?.trim() ? (
                    <span className="block truncate text-[11px] text-subtle">{member.email}</span>
                  ) : null}
                </span>
                {member.status !== "active" ? (
                  <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.08em] text-subtle">
                    {member.status}
                  </span>
                ) : null}
                <span className="w-[64px] shrink-0 text-right text-[12px] capitalize text-muted-foreground">
                  {member.is_owner ? "Owner" : member.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        to="/workspace/settings"
        className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        Manage members in workspace settings
      </Link>
    </section>
  );
}
