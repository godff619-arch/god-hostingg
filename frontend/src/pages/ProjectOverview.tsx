// Project Overview — the one canonical page for a project group. It serves two
// routes, because the only difference between them is how many environments are
// on screen:
//
//   /projects/:projectId                                → every environment
//   /projects/:projectId/environments/:environmentId    → just that one
//
// Layout, top to bottom: tiny uppercase label, the project (or environment) name
// with an inline rename pencil, the environment selector, a full-width divider,
// then one section per environment carrying dynamic `All (X) Services (X) Env
// Groups (X)` tabs, a full-width resource search, the resource table with a `⋯`
// row menu, `+ New` beneath it, and the dashed `+ Add environment` card.
//
// Every count and row comes from `GET /api/workspace/projects/:id`. §22 is the
// hard rule here: an empty project renders `All (0) Services (0) Env Groups (0)`
// and "No resources yet" — it never invents a service.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  Container,
  Database,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useBreadcrumbLeaf } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import {
  deployQuery,
  environmentPath,
  projectPath,
  projectsPath,
  servicePath,
} from "@/lib/hierarchy";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import type {
  EnvironmentRow,
  ProjectOverviewPayload,
  ResourceRow,
  ResourceState,
} from "@/lib/workspaceTypes";
import { cn } from "@/lib/utils";

/** STATUS column copy per resource state (spec §13). */
const STATE: Record<
  ResourceState,
  { label: string; icon: typeof Check; className: string; spin?: boolean }
> = {
  deployed: {
    label: "Deployed",
    icon: Check,
    className: "border-success-border bg-success-surface text-success",
  },
  deploying: {
    label: "Deploying",
    icon: Loader2,
    className: "border-brand-strong bg-brand/25 text-info",
    spin: true,
  },
  building: {
    label: "Building",
    icon: Loader2,
    className: "border-warning-border bg-warning-surface text-warning",
    spin: true,
  },
  failed: {
    label: "Failed",
    icon: X,
    className: "border-danger-border bg-danger-surface text-danger",
  },
  suspended: {
    label: "Suspended by you",
    icon: Circle,
    className: "border-border bg-secondary text-muted-foreground",
  },
  pending: {
    label: "Not deployed yet",
    icon: Circle,
    className: "border-border bg-secondary text-muted-foreground",
  },
};

function StatusCell({ state }: { state: ResourceState }) {
  const meta = STATE[state];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[3px] text-[11px]",
        meta.className,
      )}
    >
      <Icon
        className={cn("h-3 w-3 shrink-0", meta.spin && "animate-spin")}
        strokeWidth={2}
      />
      {meta.label}
    </span>
  );
}

/** "5 minutes ago" — the UPDATED column. Absolute dates never appear here. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const units: Array<[number, string]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
  ];
  let value = seconds;
  let unit = "second";
  for (const [size, name] of units) {
    if (value < size) break;
    value = Math.round(value / size);
    unit = name === "second" ? "minute" : nextUnit(name);
  }
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

function nextUnit(unit: string): string {
  const order = ["second", "minute", "hour", "day", "month", "year"];
  const index = order.indexOf(unit);
  return order[Math.min(index + 1, order.length - 1)];
}

export default function ProjectOverview() {
  const { projectId = "", environmentId } = useParams();
  const id = projectId;
  const [searchParams, setSearchParams] = useSearchParams();
  const { canWrite, refresh: refreshWorkspace } = useWorkspace();
  const [data, setData] = useState<ProjectOverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  useBreadcrumbLeaf(data?.project.name);

  const load = useCallback(async () => {
    try {
      const payload = await apiGet<ProjectOverviewPayload>(
        scoped(`/api/workspace/projects/${encodeURIComponent(id)}`),
      );
      setData(payload);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // `+ Add environment` in the project rail links here with `?newEnvironment=1`
  // so there is only ever one create-environment dialog in the app.
  useEffect(() => {
    if (searchParams.get("newEnvironment") !== "1") return;
    setEnvOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("newEnvironment");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const reload = async () => {
    setReloading(true);
    await load();
    setReloading(false);
  };

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-2 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
        <Link
          to="/projects"
          className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Back to Projects
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="h-3 w-16 animate-pulse rounded bg-secondary" />
        <div className="mt-3 h-7 w-56 animate-pulse rounded bg-secondary" />
        <div className="mt-6 h-px w-full bg-border" />
        <div className="mt-6 h-9 w-full animate-pulse rounded-md bg-secondary/60" />
        <div className="mt-3 h-32 w-full animate-pulse rounded-md bg-secondary/40" />
      </div>
    );
  }

  const environments = data.environments;
  // `/projects/:projectId/environments/:environmentId` narrows the page to one
  // environment; the bare project route shows them all.
  const focused = environmentId
    ? environments.find((env) => env.id === environmentId) ?? null
    : null;
  const shown = focused ? [focused] : environments;
  const unknownEnvironment = Boolean(environmentId) && !focused;

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      {focused ? (
        <Link
          to={projectPath(id)}
          className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          {data.project.name}
        </Link>
      ) : null}

      <div className="text-[10px] font-medium uppercase tracking-[0.11em] text-subtle">
        {focused ? "Environment" : "Project"}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[27px] font-medium leading-tight text-foreground">
            {focused ? focused.name : data.project.name}
          </h1>
          {focused ? null : (
            <button
              type="button"
              onClick={() => setRenaming(true)}
              disabled={!canWrite}
              aria-label="Rename project"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          aria-label="Refresh resources"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", reloading && "animate-spin")}
            strokeWidth={1.75}
          />
        </button>
      </div>

      {!focused && data.project.description ? (
        <p className="mt-1.5 max-w-[720px] text-[13px] text-muted-foreground">
          {data.project.description}
        </p>
      ) : null}

      {/* Environment selector — every environment of this project, one click away. */}
      {environments.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Link
            to={projectPath(id)}
            aria-current={focused ? undefined : "page"}
            className={cn(
              "inline-flex h-7 items-center rounded-md border px-2.5 text-[12px] transition-colors",
              focused
                ? "border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
                : "border-brand-strong bg-brand/20 text-foreground",
            )}
          >
            All environments
          </Link>
          {environments.map((env) => (
            <Link
              key={env.id}
              to={environmentPath(id, env.id)}
              aria-current={env.id === environmentId ? "page" : undefined}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
                env.id === environmentId
                  ? "border-brand-strong bg-brand/20 text-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {env.name}
              <span className="text-subtle">{env.counts.all}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {/* Full-width divider under the title block (spec §9). */}
      <div className="mt-5 h-px w-full bg-border" />

      {error ? (
        <div className="mt-4 rounded-md border border-danger-border bg-danger-surface p-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {unknownEnvironment ? (
        <div className="mt-4 rounded-md border border-warning-border bg-warning-surface p-3 text-[13px] text-warning">
          That environment is not part of this project.
        </div>
      ) : null}

      {shown.map((environment) => (
        <EnvironmentSection
          key={environment.id}
          projectId={id}
          environment={environment}
          resources={data.resources.filter((r) => r.environment_id === environment.id)}
          canWrite={canWrite}
          onChanged={() => {
            void load();
            void refreshWorkspace();
          }}
        />
      ))}

      {/* Resources whose environment row was removed out from under them. */}
      {!focused && data.resources.some((r) => !r.environment_id) ? (
        <EnvironmentSection
          projectId={id}
          environment={{
            id: "__unassigned__",
            name: "Unassigned",
            is_default: true,
            counts: {
              all: data.resources.filter((r) => !r.environment_id).length,
              services: data.resources.filter((r) => !r.environment_id && r.type === "service")
                .length,
              databases: data.resources.filter((r) => !r.environment_id && r.type === "database")
                .length,
              env_groups: 0,
            },
          }}
          resources={data.resources.filter((r) => !r.environment_id)}
          canWrite={canWrite}
          onChanged={() => void load()}
        />
      ) : null}

      {focused ? null : (
        <button
          type="button"
          onClick={() => setEnvOpen(true)}
          disabled={!canWrite}
          className="mt-6 flex h-[74px] w-full items-center justify-center gap-2 rounded-md border border-dashed border-border text-[13px] text-muted-foreground transition-colors duration-150 hover:border-brand-ring hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add environment
        </button>
      )}

      <RenameProjectDialog
        open={renaming}
        onOpenChange={setRenaming}
        projectId={data.project.id}
        name={data.project.name}
        description={data.project.description}
        onSaved={(project) => {
          setData((current) =>
            current ? { ...current, project: { ...current.project, ...project } } : current,
          );
          void refreshWorkspace();
        }}
      />

      <CreateEnvironmentDialog
        open={envOpen}
        onOpenChange={setEnvOpen}
        projectId={data.project.id}
        onCreated={() => void load()}
      />

      <div className="mt-8">
        <Link
          to={projectsPath}
          className="inline-flex items-center gap-1.5 text-[12px] text-subtle transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          All projects
        </Link>
      </div>
    </div>
  );
}

type Tab = "all" | "services" | "env_groups";

/**
 * One environment block: dynamic tabs, the search field, the table and `+ New`.
 * Counts are derived from the rows actually returned — never hardcoded (§11).
 *
 * `projectId` is threaded in (rather than read from the URL) so every row links to
 * the canonical nested service URL and `+ New` can pre-target this environment.
 */
function EnvironmentSection({
  projectId,
  environment,
  resources,
  canWrite,
  onChanged,
}: {
  projectId: string;
  environment: EnvironmentRow;
  resources: ResourceRow[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(false);

  const counts = {
    all: resources.length,
    services: resources.filter((r) => r.type === "service").length,
    env_groups: environment.counts.env_groups,
  };

  const tabbed = useMemo(() => {
    if (tab === "services") return resources.filter((r) => r.type === "service");
    if (tab === "env_groups") return [];
    return resources;
  }, [resources, tab]);

  // Filter by name, runtime, region or status (spec §10).
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tabbed;
    return tabbed.filter((row) =>
      `${row.name} ${row.runtime} ${row.region ?? ""} ${STATE[row.state].label}`
        .toLowerCase()
        .includes(needle),
    );
  }, [tabbed, query]);

  return (
    <section className="mt-6">
      <div className="flex items-center gap-1.5">
        <h2 className="text-[19px] font-medium text-foreground">{environment.name}</h2>
        {!environment.is_default && canWrite ? (
          <button
            type="button"
            onClick={() => setDeleting(true)}
            aria-label={`Delete ${environment.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <TabButton active={tab === "all"} onClick={() => setTab("all")}>
          All ({counts.all})
        </TabButton>
        <TabButton active={tab === "services"} onClick={() => setTab("services")}>
          Services ({counts.services})
        </TabButton>
        <TabButton active={tab === "env_groups"} onClick={() => setTab("env_groups")}>
          Env Groups ({counts.env_groups})
        </TabButton>
      </div>

      <div className="relative mt-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
          strokeWidth={1.75}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search resources in ${environment.name}`}
          aria-label={`Search resources in ${environment.name}`}
          className="h-9 w-full rounded-md border border-border bg-secondary/40 pl-9 pr-9 text-[13px] text-foreground outline-none transition-colors placeholder:text-subtle focus:border-brand-ring"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* §22: an empty environment says so; it never lists a service that
          does not exist in the database. */}
      {counts.all === 0 ? (
        <div className="mt-3 rounded-md border border-border p-8 text-center">
          <p className="text-[14px] text-foreground">No resources yet</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Create a resource to get started.
          </p>
          <div className="mt-3 flex justify-center">
            <NewResourceMenu
              disabled={!canWrite}
              projectId={projectId}
              environmentId={environment.id}
            />
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted-foreground">No matching resources found.</p>
      ) : tab === "env_groups" ? (
        <p className="mt-4 text-[13px] text-muted-foreground">
          No environment groups in {environment.name}.{" "}
          <Link to="/environment-groups" className="underline hover:no-underline">
            Manage environment groups
          </Link>
        </p>
      ) : (
        <ResourceTable
          rows={filtered}
          projectId={projectId}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      )}

      {counts.all > 0 ? (
        <div className="mt-3">
          <NewResourceMenu
            disabled={!canWrite}
            projectId={projectId}
            environmentId={environment.id}
          />
        </div>
      ) : null}

      <DeleteEnvironmentDialog
        open={deleting}
        onOpenChange={setDeleting}
        environment={environment}
        onDeleted={onChanged}
      />
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
        active
          ? "bg-brand text-brand-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * `+ New` under the table — the same create targets God Hosting can honour.
 *
 * The project and environment travel with the link, so a resource created from
 * inside an environment is born there instead of landing in the default one (§14).
 * The synthetic "Unassigned" bucket has no real environment row, so only the
 * project is carried in that case.
 */
function NewResourceMenu({
  disabled,
  projectId,
  environmentId,
}: {
  disabled: boolean;
  projectId: string;
  environmentId?: string;
}) {
  const navigate = useNavigate();
  const realEnvironment =
    environmentId && !environmentId.startsWith("__") ? environmentId : undefined;
  const placement = deployQuery(projectId, realEnvironment);
  const extra = placement ? `&${placement.slice(1)}` : "";
  return (
    <Dropdown
      label="Create a resource"
      triggerClassName="h-8 gap-1.5 border border-border px-2.5 hover:bg-secondary"
      trigger={(open) => (
        <>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          <span className="text-[12px]">New</span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform duration-150",
              open && "rotate-180",
            )}
            strokeWidth={2}
          />
        </>
      )}
    >
      <DropdownItem
        icon={<Container className="h-3.5 w-3.5" />}
        disabled={disabled}
        onClick={() => navigate(`/projects/new${placement}`)}
      >
        Web Service
      </DropdownItem>
      <DropdownItem
        icon={<Database className="h-3.5 w-3.5" />}
        disabled={disabled}
        onClick={() => navigate(`/databases/new?engine=postgres${extra}`)}
      >
        PostgreSQL
      </DropdownItem>
      <DropdownItem
        icon={<Database className="h-3.5 w-3.5" />}
        disabled={disabled}
        onClick={() => navigate(`/databases/new?engine=redis${extra}`)}
      >
        Redis
      </DropdownItem>
    </Dropdown>
  );
}

/** SERVICE NAME | STATUS | RUNTIME | REGION | UPDATED | ⋯ (spec §12). */
function ResourceTable({
  rows,
  projectId,
  canWrite,
  onChanged,
}: {
  rows: ResourceRow[];
  projectId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {["Service name", "Status", "Runtime", "Region", "Updated"].map((head) => (
              <th
                key={head}
                className="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle"
              >
                {head}
              </th>
            ))}
            <th className="w-10 px-3 py-2" aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-border last:border-0 transition-colors hover:bg-secondary/60"
            >
              <td className="px-3 py-2.5">
                <Link
                  to={servicePath(projectId, row.environment_id, row.id)}
                  className="flex min-w-0 items-center gap-2 text-[13px] text-foreground hover:underline"
                >
                  {row.type === "database" ? (
                    <Database className="h-3.5 w-3.5 shrink-0 text-subtle" strokeWidth={1.75} />
                  ) : (
                    <Container className="h-3.5 w-3.5 shrink-0 text-subtle" strokeWidth={1.75} />
                  )}
                  <span className="truncate">{row.name}</span>
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <StatusCell state={row.state} />
              </td>
              <td className="px-3 py-2.5">
                <span className="inline-flex items-center rounded-[3px] border border-border bg-secondary px-1.5 py-[2px] text-[11px] text-muted-foreground">
                  {row.runtime}
                </span>
              </td>
              {/* Region is omitted rather than invented when unconfigured (§16). */}
              <td className="px-3 py-2.5 text-[12px] text-muted-foreground">
                {row.region ?? "—"}
              </td>
              <td className="px-3 py-2.5 text-[12px] text-muted-foreground">
                {relativeTime(row.updated_at)}
              </td>
              <td className="px-3 py-2.5 text-right">
                <RowMenu
                  row={row}
                  projectId={projectId}
                  canWrite={canWrite}
                  onChanged={onChanged}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `⋯` row menu. Suspend/Resume swap by state; nothing here is a dead entry. */
function RowMenu({
  row,
  projectId,
  canWrite,
  onChanged,
}: {
  row: ResourceRow;
  projectId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const suspended = row.state === "suspended";
  const href = servicePath(projectId, row.environment_id, row.id);

  const run = async (label: string, path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiSend(path, "POST");
      toast.success(`${label} started for “${row.name}”.`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dropdown
        align="end"
        label={`Actions for ${row.name}`}
        triggerClassName="h-7 w-7 justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
        trigger={() =>
          busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          ) : (
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
          )
        }
      >
        <DropdownItem onClick={() => navigate(href)}>Open</DropdownItem>
        {row.type === "service" ? (
          <>
            <DropdownItem
              disabled={!canWrite}
              onClick={() => void run("Deploy", `/api/deployments/${row.id}/deploy`)}
            >
              Deploy
            </DropdownItem>
            <DropdownItem
              disabled={!canWrite}
              onClick={() => navigate(`${href}?tab=deployments`)}
            >
              Manual Deploy
            </DropdownItem>
            <DropdownSeparator />
            {suspended ? (
              <DropdownItem
                disabled={!canWrite}
                onClick={() => void run("Resume", `/api/deployments/${row.id}/restart`)}
              >
                Resume
              </DropdownItem>
            ) : (
              <DropdownItem
                disabled={!canWrite}
                onClick={() => void run("Suspend", `/api/deployments/${row.id}/stop`)}
              >
                Suspend
              </DropdownItem>
            )}
          </>
        ) : null}
        <DropdownSeparator />
        <DropdownItem onClick={() => navigate(`${href}?tab=logs`)}>View Logs</DropdownItem>
        <DropdownItem onClick={() => navigate(`${href}?tab=env`)}>Settings</DropdownItem>
        <DropdownSeparator />
        <DropdownItem
          disabled={!canWrite}
          onClick={() => setConfirmDelete(true)}
          className="text-danger hover:bg-danger-surface"
          icon={<Trash2 className="h-3.5 w-3.5" />}
        >
          Delete
        </DropdownItem>
      </Dropdown>

      <ConfirmDeleteResource
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        row={row}
        onDeleted={onChanged}
      />
    </>
  );
}

/** Destructive actions always confirm (spec §77). */
function ConfirmDeleteResource({
  open,
  onOpenChange,
  row,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ResourceRow;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = async () => {
    setSaving(true);
    try {
      await apiSend(`/api/projects/${row.id}`, "DELETE");
      toast.success(`“${row.name}” deleted.`);
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
          <DialogTitle>Delete “{row.name}”?</DialogTitle>
          <DialogDescription>
            The container, its volumes and its deployment history are removed. This cannot
            be undone.
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
            {saving ? "Deleting…" : "Delete resource"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inline rename (the ✎ next to the title) → `PATCH /api/workspace/projects/:id`. */
function RenameProjectDialog({
  open,
  onOpenChange,
  projectId,
  name,
  description,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  name: string;
  description: string | null;
  onSaved: (project: { name: string; description: string | null }) => void;
}) {
  const [value, setValue] = useState(name);
  const [desc, setDesc] = useState(description ?? "");
  const [saving, setSaving] = useState(false);

  // Re-seed each time the dialog opens so a cancelled edit is discarded.
  useEffect(() => {
    if (!open) return;
    setValue(name);
    setDesc(description ?? "");
  }, [open, name, description]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const data = await apiSend<{ project: { name: string; description: string | null } }>(
        scoped(`/api/workspace/projects/${encodeURIComponent(projectId)}`),
        "PATCH",
        { name: trimmed, description: desc.trim() || null },
      );
      onSaved(data.project);
      toast.success("Project updated");
      onOpenChange(false);
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
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            The name shows on the dashboard card and in the breadcrumb.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="rename-project" className="text-[12px] text-muted-foreground">
              Project Name
            </label>
            <Input
              id="rename-project"
              value={value}
              autoFocus
              maxLength={60}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="rename-desc" className="text-[12px] text-muted-foreground">
              Project Description
            </label>
            <textarea
              id="rename-desc"
              value={desc}
              maxLength={280}
              rows={3}
              onChange={(event) => setDesc(event.target.value)}
              placeholder="Optional"
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none placeholder:text-subtle focus:border-brand-ring"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !value.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `+ Add environment` → `POST /api/workspace/projects/:id/environments`. */
function CreateEnvironmentDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await apiSend(
        scoped(`/api/workspace/projects/${encodeURIComponent(projectId)}/environments`),
        "POST",
        { name: trimmed },
      );
      toast.success(`Environment “${trimmed}” created`);
      onOpenChange(false);
      setName("");
      onCreated();
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
          <DialogTitle>Create environment</DialogTitle>
          <DialogDescription>
            Environments keep separate resources inside the same project — for example
            Staging alongside Production.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="env-name" className="text-[12px] text-muted-foreground">
              Environment name
            </label>
            <Input
              id="env-name"
              value={name}
              autoFocus
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="Staging"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create Environment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentDialog({
  open,
  onOpenChange,
  environment,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: EnvironmentRow;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const remove = async () => {
    setSaving(true);
    try {
      await apiSend(
        scoped(`/api/workspace/environments/${encodeURIComponent(environment.id)}`),
        "DELETE",
      );
      toast.success(`Environment “${environment.name}” deleted`);
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
          <DialogTitle>Delete “{environment.name}”?</DialogTitle>
          <DialogDescription>
            The environment must be empty. Its resources are not deleted by this action.
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


