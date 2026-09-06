// PROJECTS — the top level of the hierarchy (Projects → Project → Environment →
// Service). One card per real project group from `GET /api/workspace/projects`:
// name, description, environment + service counts, aggregated status and the
// last deploy. Cards link to `/projects/:projectId` (the project overview) — never
// straight to a service.
//
// The cards endpoint returns summaries only; environments and services are loaded
// by the project overview, so opening this page never fetches every service in
// every project.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { NewMenu } from "@/components/shell/TopHeader";
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
import { projectPath } from "@/lib/hierarchy";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import type { ProjectCard, ProjectHealth, WorkspaceRole } from "@/lib/workspaceTypes";
import { cn } from "@/lib/utils";

/** Card badge copy per aggregated state. `empty` never claims health. */
const HEALTH: Record<
  ProjectHealth,
  { label: string; icon: typeof Check; className: string; dot: string }
> = {
  healthy: {
    label: "All services are up and running",
    icon: Check,
    className: "border-success-border bg-success-surface text-success",
    dot: "bg-success",
  },
  warning: {
    label: "Some services have warnings",
    icon: AlertTriangle,
    className: "border-warning-border bg-warning-surface text-warning",
    dot: "bg-warning",
  },
  error: {
    label: "Some services are down",
    icon: X,
    className: "border-danger-border bg-danger-surface text-danger",
    dot: "bg-danger",
  },
  deploying: {
    label: "Deployment in progress",
    icon: Loader2,
    className: "border-brand-strong bg-brand/25 text-info",
    dot: "bg-info",
  },
  empty: {
    label: "No resources yet",
    icon: CircleDashed,
    className: "border-border bg-secondary text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

function HealthBadge({ health }: { health: ProjectHealth }) {
  const state = HEALTH[health];
  const Icon = state.icon;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-[3px] border px-1.5 py-[3px] text-[11px]",
        state.className,
      )}
    >
      <Icon
        className={cn("h-3 w-3 shrink-0", health === "deploying" && "animate-spin")}
        strokeWidth={2}
      />
      <span className="truncate">{state.label}</span>
    </span>
  );
}

/** "3m ago" / "2d ago". Returns null for a missing timestamp so callers can omit the line. */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Deploy summary line — only states that actually occur are mentioned. */
function deploySummary(card: ProjectCard): string {
  if (card.counts.resources === 0) return "No resources yet";
  const parts: string[] = [];
  if (card.states.deployed) parts.push(`${card.states.deployed} live`);
  if (card.states.building + card.states.deploying) {
    parts.push(`${card.states.building + card.states.deploying} deploying`);
  }
  if (card.states.failed) parts.push(`${card.states.failed} failed`);
  if (card.states.suspended) parts.push(`${card.states.suspended} suspended`);
  if (card.states.pending) parts.push(`${card.states.pending} not deployed`);
  return parts.join(" · ");
}

export default function Projects() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { workspace, canWrite, refresh: refreshWorkspace } = useWorkspace();
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ projects: ProjectCard[] }>(
        scoped("/api/workspace/projects"),
      );
      setProjects(data.projects);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, workspace?.id]);

  // `+ New → New Project` from any page lands here with `?new=project`.
  useEffect(() => {
    if (searchParams.get("new") !== "project") return;
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const reload = async () => {
    setReloading(true);
    await Promise.all([load(), refreshWorkspace()]);
    setReloading(false);
  };

  // Local, per-keystroke filter over already-loaded cards — no refetch.
  const visible = useMemo(() => {
    if (!projects) return null;
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [projects, query]);

  // PROJECTS_BODY
  const totals = useMemo(() => {
    const base = { projects: 0, services: 0, live: 0, deploying: 0, failed: 0 };
    for (const p of projects ?? []) {
      base.projects += 1;
      base.services += p.counts.resources;
      base.live += p.states.deployed;
      base.deploying += p.states.deploying + p.states.building;
      base.failed += p.states.failed;
    }
    return base;
  }, [projects]);

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[27px] font-medium leading-tight text-foreground">Projects</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            disabled={!canWrite}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-[12px] text-foreground transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-50"
          >
            <UserPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Invite your team
          </button>
          <NewMenu onNewProject={() => setCreateOpen(true)} />
        </div>
      </div>

      {projects !== null && projects.length > 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {totals.projects} project{totals.projects === 1 ? "" : "s"} ·{" "}
          {totals.services} resource{totals.services === 1 ? "" : "s"} ·{" "}
          {totals.live} live
          {totals.deploying > 0 ? ` · ${totals.deploying} deploying` : ""}
          {totals.failed > 0 ? ` · ${totals.failed} failed` : ""}
        </p>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="relative w-full max-w-[280px]">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
            strokeWidth={1.75}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-[13px] outline-none placeholder:text-subtle focus:border-brand-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          aria-label="Refresh projects"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", reloading && "animate-spin")}
            strokeWidth={1.75}
          />
        </button>
      </div>

      {/* PROJECTS_GRID */}
      {error ? (
        <div className="mt-3 rounded-md border border-danger-border bg-danger-surface p-3 text-[13px] text-danger">
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-2 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {projects !== null && projects.length === 0 && !error ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          No projects yet. Create one to group your services, databases and
          environments.
        </p>
      ) : null}

      {visible !== null && projects !== null && projects.length > 0 && visible.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          No project matches “{query}”.
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 stagger-in">
        {projects === null && !error
          ? [0, 1, 2].map((key) => (
              <div
                key={key}
                className="h-[112px] animate-pulse rounded-md border border-border bg-secondary/40"
              />
            ))
          : null}

        {visible?.map((project) => (
          <ProjectSummaryCard key={project.id} project={project} />
        ))}

        {projects !== null && canWrite && !query ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex h-[112px] items-center justify-center gap-2 rounded-md border border-dashed border-border text-[13px] text-muted-foreground transition-colors duration-150 hover:border-brand-ring hover:bg-secondary hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Create new project
          </button>
        ) : null}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(project) => {
          setProjects((current) => (current ? [...current, project] : [project]));
          void refreshWorkspace();
        }}
      />
      <InviteTeamDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

/** One project card. Clicking it opens the project overview, never a service. */
function ProjectSummaryCard({ project }: { project: ProjectCard }) {
  const updated = relativeTime(project.last_deployed_at ?? project.updated_at);
  return (
    <Link
      to={projectPath(project.id)}
      className="flex h-[112px] flex-col justify-between rounded-md border border-border bg-transparent px-3 py-2.5 transition-colors duration-150 hover:bg-secondary"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn("h-2 w-2 shrink-0 rounded-full", HEALTH[project.health].dot)}
          />
          <span className="truncate text-[13px] font-medium text-foreground">
            {project.name}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-subtle">
          {project.description ||
            `${project.counts.environments} environment${project.counts.environments === 1 ? "" : "s"} · ${project.counts.services} service${project.counts.services === 1 ? "" : "s"}`}
        </div>
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {deploySummary(project)}
          {updated ? ` · updated ${updated}` : ""}
        </div>
      </div>
      <HealthBadge health={project.health} />
    </Link>
  );
}

/**
 * Project Name + Description + initial environment → `POST /api/workspace/projects`,
 * then straight into the new project's overview (spec §11).
 */
function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectCard) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState("Production");
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const data = await apiSend<{ project: ProjectCard }>(
        scoped("/api/workspace/projects"),
        "POST",
        {
          name: trimmed,
          description: description.trim() || null,
          environment: environment.trim() || "Production",
        },
      );
      onCreated(data.project);
      toast.success(`Project “${data.project.name}” created`);
      onOpenChange(false);
      setName("");
      setDescription("");
      setEnvironment("Production");
      navigate(projectPath(data.project.id));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // CREATE_DIALOG_BODY
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a project</DialogTitle>
          <DialogDescription>
            A project groups services, databases and environments.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="project-name" className="text-[12px] text-muted-foreground">
              Project Name
            </label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Payments platform"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="project-desc" className="text-[12px] text-muted-foreground">
              Project Description
            </label>
            <textarea
              id="project-desc"
              value={description}
              maxLength={280}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none placeholder:text-subtle focus:border-brand-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="project-env" className="text-[12px] text-muted-foreground">
              Initial environment
            </label>
            <Input
              id="project-env"
              value={environment}
              maxLength={40}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="Production"
            />
            <p className="text-[11px] text-subtle">
              You can add Staging, Development or your own environments later.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Invite several teammates at once → `POST /api/workspace/members`. */
function InviteTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("developer");
  const [saving, setSaving] = useState(false);

  const emails = raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = emails.filter((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (emails.length === 0 || invalid.length > 0) return;
    setSaving(true);
    try {
      const data = await apiSend<{ invited: number; total: number }>(
        scoped("/api/workspace/members"),
        "POST",
        { emails, role },
      );
      toast.success(
        data.invited === 1 ? "1 invitation sent" : `${data.invited} invitations sent`,
      );
      onOpenChange(false);
      setRaw("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // INVITE_DIALOG_BODY
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite your team</DialogTitle>
          <DialogDescription>
            One or more email addresses, separated by commas, spaces or new lines.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <textarea
            value={raw}
            rows={4}
            autoFocus
            onChange={(e) => setRaw(e.target.value)}
            placeholder={"ada@example.com\ngrace@example.com"}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none placeholder:text-subtle focus:border-brand-ring"
          />
          <div className="space-y-1.5">
            <label htmlFor="invite-role" className="text-[12px] text-muted-foreground">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as WorkspaceRole)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] outline-none focus:border-brand-ring"
            >
              <option value="admin">Admin</option>
              <option value="developer">Developer</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          {invalid.length > 0 ? (
            <p className="text-[12px] text-danger">
              Not a valid email: {invalid.slice(0, 3).join(", ")}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || emails.length === 0 || invalid.length > 0}
            >
              {saving ? "Inviting…" : "Invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
