// Render-style rail: 228px wide, flat #111111 plane, 1px right divider, sits
// directly below the 48px header and runs to the bottom of the viewport.
//
// Order is fixed by the spec: Projects / Blueprints / Environment Groups, then
// INTEGRATIONS, NETWORKING, WORKSPACE, then the operator-only groups. The purple
// promo card is dismissible and the dismissal is remembered in localStorage.

import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useMatch } from "react-router-dom";
import {
  ChevronRight,
  Circle,
  Info,
  Layers,
  LayoutGrid,
  LifeBuoy,
  Plus,
  Settings,
  UserPlus,
  X,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { useShell } from "@/components/shell/ShellContext";
import { isNavActive, visibleNavGroups, type NavItem } from "@/components/shell/navigation";
import { isProjectGroupId, useProjectNav } from "@/lib/hierarchy";
import { API_URL, cn } from "@/lib/utils";
import { hasAdminAccess, isFullAdmin } from "@/lib/roles";

const PROMO_KEY = "docklift_promo_workflows_dismissed";

export function Sidebar({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { setMobileOpen, breadcrumbLeaf } = useShell();
  const groups = visibleNavGroups(hasAdminAccess(user?.role), isFullAdmin(user?.role));
  const isMobile = variant === "mobile";
  // Inside a project group the rail becomes project-scoped (spec Part B §5–§8).
  //
  // Both hooks are called unconditionally on every render. Guarding the second
  // behind `??` short-circuits it whenever the first matches, which changes the
  // hook count between renders of this persistently-mounted component and throws
  // "Rendered fewer hooks than expected". `/*` already matches the bare path, so
  // the splat form alone is enough — the exact form is kept only for clarity and
  // is always evaluated.
  const projectSplat = useMatch("/projects/:projectId/*");
  const legacySplat = useMatch("/project/:projectId/*");
  const rawProjectId = projectSplat?.params.projectId ?? legacySplat?.params.projectId ?? null;
  // `/projects/:id` is shared: `prj-` ids are project groups, UUIDs are single
  // resources (legacy bookmarks), and `/projects/new` is the deploy wizard.
  const projectId = rawProjectId && isProjectGroupId(rawProjectId) ? rawProjectId : null;

  const close = useCallback(() => {
    if (isMobile) setMobileOpen(false);
  }, [isMobile, setMobileOpen]);

  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {isMobile ? (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
          <Link to="/" onClick={close} className="flex items-center gap-2">
            <img src="/logo.png" alt="" className="h-5 w-5 rounded" />
            <span className="text-[13px] font-medium">God Hosting</span>
          </Link>
          <button
            type="button"
            onClick={close}
            aria-label="Close navigation"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}

      {projectId ? (
        <ProjectRail
          projectId={projectId}
          projectName={breadcrumbLeaf}
          pathname={pathname}
          onNavigate={close}
        />
      ) : (
        <nav className="shell-scroll flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group, index) => (
            <div key={group.label || `group-${index}`} className={index === 0 ? "" : "mt-5"}>
              {group.label ? (
                <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
                  {group.label}
                </div>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <RailLink item={item} active={isNavActive(pathname, item)} onNavigate={close} />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <WorkflowsPromo />
        </nav>
      )}

      <SidebarFooter onNavigate={close} />
    </div>
  );
}

/**
 * Project-scoped rail: `← Projects`, the project itself, OVERVIEW, the real
 * ENVIRONMENTS of this project, then MANAGE. The environment list comes from the
 * cheap nav endpoint (no resource rows), so opening a service page does not
 * re-fetch the whole project.
 */
function ProjectRail({
  projectId,
  projectName,
  pathname,
  onNavigate,
}: {
  projectId: string;
  projectName: string | null;
  pathname: string;
  onNavigate: () => void;
}) {
  const base = `/projects/${projectId}`;
  const onSettings = pathname.startsWith(`${base}/settings`);
  const { environments, name: fetchedName } = useProjectNav(projectId);
  // Which environment the current URL is inside, if any.
  const activeEnvironment = pathname.startsWith(`${base}/environments/`)
    ? pathname.slice(`${base}/environments/`.length).split("/")[0]
    : null;
  const onOverview = !onSettings && !activeEnvironment;

  return (
    <nav className="shell-scroll flex-1 overflow-y-auto px-2 py-3">
      <Link
        to="/projects"
        onClick={onNavigate}
        className="flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] text-sidebar-muted transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4 shrink-0 rotate-180" strokeWidth={1.75} />
        <span className="truncate">Projects</span>
      </Link>

      <div className="mt-2 flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] text-foreground">
        <Circle className="h-4 w-4 shrink-0 fill-current text-brand-ring" strokeWidth={0} />
        <span className="truncate">{projectName || fetchedName || "Project"}</span>
      </div>

      <div className="mt-4">
        <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
          Overview
        </div>
        <Link
          to={base}
          onClick={onNavigate}
          aria-current={onOverview ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-150",
            onOverview
              ? "bg-brand text-brand-foreground"
              : "text-sidebar-muted hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">Overview</span>
        </Link>
      </div>

      <div className="mt-4">
        <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
          Environments
        </div>
        <ul className="space-y-0.5">
          {environments.map((env) => {
            const active = env.id === activeEnvironment;
            return (
              <li key={env.id}>
                <Link
                  to={`${base}/environments/${env.id}`}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-150",
                    active
                      ? "bg-brand text-brand-foreground"
                      : "text-sidebar-muted hover:bg-sidebar-accent hover:text-foreground",
                  )}
                >
                  <Layers className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{env.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <Link
          to={`${base}?newEnvironment=1`}
          onClick={onNavigate}
          className="mt-0.5 flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] text-sidebar-muted transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">Add environment</span>
        </Link>
      </div>

      <div className="mt-4">
        <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
          Manage
        </div>
        <Link
          to={`${base}/settings`}
          onClick={onNavigate}
          aria-current={onSettings ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-150",
            onSettings
              ? "bg-brand text-brand-foreground"
              : "text-sidebar-muted hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <Settings className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">Settings</span>
        </Link>
      </div>

      <WorkflowsPromo />
    </nav>
  );
}

function RailLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={item.description}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-150",
        active
          ? "bg-brand text-brand-foreground"
          : "text-sidebar-muted hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** Purple promo card. Dismissal survives reloads (spec §14). */
function WorkflowsPromo() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(PROMO_KEY) === "true",
  );
  if (dismissed) return null;

  return (
    <div className="mt-6 rounded-md border border-brand-strong bg-brand/25 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>Introducing Workflows</span>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            localStorage.setItem(PROMO_KEY, "true");
            setDismissed(true);
          }}
          className="-mr-1 -mt-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        An orchestration and execution engine for long-running, distributed tasks.
      </p>
      <Link
        to="/docs"
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-foreground hover:underline"
      >
        Learn more
        <ChevronRight className="h-3 w-3" strokeWidth={2} />
      </Link>
    </div>
  );
}

function SidebarFooter({ onNavigate }: { onNavigate: () => void }) {
  const [changelogOpen, setChangelogOpen] = useState(false);

  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 py-2">
      <button
        type="button"
        onClick={() => setChangelogOpen((v) => !v)}
        aria-expanded={changelogOpen}
        className="flex w-full items-center justify-between rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <span>Changelog</span>
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform duration-150", changelogOpen && "rotate-90")}
          strokeWidth={1.75}
        />
      </button>
      {changelogOpen ? (
        <div className="px-2 pb-1 pt-0.5 text-[11px] leading-relaxed text-subtle">
          Release notes are published with each deploy of the control plane.
        </div>
      ) : null}

      <Link
        to="/workspace/settings#team-members"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <UserPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        Invite a friend
      </Link>
      <Link
        to="/docs"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <LifeBuoy className="h-3.5 w-3.5" strokeWidth={1.75} />
        Contact support
      </Link>
      <StatusFooterLink />
    </div>
  );
}

/** Platform status — reads the real `/api/health` probe, never a static "All good". */
function StatusFooterLink() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/health`);
        if (alive) setOk(res.ok);
      } catch {
        if (alive) setOk(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Link
      to="/system"
      className="flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-foreground"
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok === null ? "bg-subtle" : ok ? "bg-success" : "bg-danger",
        )}
      />
      Status
    </Link>
  );
}
