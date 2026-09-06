// 48px Render-style header. Left → right: logo, vertical divider, workspace
// selector, breadcrumb. Right → left: account avatar, help, Upgrade, + New,
// search. Every value comes from the signed-in user's real workspace
// (`GET /api/workspace`) — nothing here is hardcoded per account.

import { Fragment, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Database,
  HeartPulse,
  Keyboard,
  Layers,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  Menu,
  Network,
  Plus,
  Search,
  Settings,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { deployQuery, useHierarchyContext, useProjectNav } from "@/lib/hierarchy";
import { errorMessage } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import { breadcrumbsFor } from "./navigation";
import { useShell } from "./ShellContext";

export function TopHeader() {
  const { pathname } = useLocation();
  const { setMobileOpen, setPaletteOpen, breadcrumbLeaf } = useShell();
  const [modKey, setModKey] = useState("⌘");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Ids are not labels: the trail needs the project and environment *names*, and
  // this is the one place that knows the whole URL. The nav endpoint is cheap and
  // cached per project, so asking here costs one small request per project visit.
  const { projectId, environmentId } = useHierarchyContext();
  const { name: projectName, environments } = useProjectNav(projectId);
  const crumbs = breadcrumbsFor(pathname, breadcrumbLeaf ?? undefined, {
    projectName,
    environmentName: environments.find((env) => env.id === environmentId)?.name ?? null,
  });

  useEffect(() => {
    setModKey(/Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘" : "Ctrl ");
  }, []);

  return (
    <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-border bg-header px-3">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
      >
        <Menu className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <Link to="/projects" aria-label="God Hosting home" className="shrink-0">
        <img src="/logo.png" alt="" className="h-[22px] w-[22px] rounded-[5px]" />
      </Link>

      <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block" />

      <WorkspaceSelector />

      <nav
        aria-label="Breadcrumb"
        className="hidden min-w-0 items-center gap-1.5 pl-1 text-[13px] md:flex"
      >
        <Network className="h-3.5 w-3.5 shrink-0 text-subtle" strokeWidth={1.75} />
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 ? (
              <ChevronRight className="h-3 w-3 shrink-0 text-subtle" strokeWidth={2} />
            ) : null}
            {crumb.href ? (
              <Link
                to={crumb.href}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate text-foreground">{crumb.label}</span>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search"
          className="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-border px-1 py-px text-[10px] font-medium text-subtle md:inline">
            {modKey}K
          </kbd>
        </button>

        <NewMenu />
        <UpgradeButton />
        <HelpMenu onShortcuts={() => setShortcutsOpen(true)} />
        <UserMenu onShortcuts={() => setShortcutsOpen(true)} />
      </div>

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        modKey={modKey}
      />
    </header>
  );
}

/**
 * `[M] My Workspace ˄` — the real workspace name and its initial. The switcher
 * lists every workspace the caller belongs to; the server re-checks membership,
 * so a stale selection can only fail closed.
 */
function WorkspaceSelector() {
  const navigate = useNavigate();
  const { workspace, workspaces, loading, switchWorkspace } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  const name = workspace?.name ?? (loading ? "Loading…" : "Workspace");
  const initial = workspace?.initial ?? "W";
  const others = workspaces.filter((w) => w.id !== workspace?.id);

  return (
    <>
      <Dropdown
        label="Workspace menu"
        triggerClassName="h-8 shrink-0 gap-1.5 px-1.5 hover:bg-secondary"
        className="min-w-[248px]"
        trigger={(open) => (
          <>
            <span
              aria-hidden
              className="flex h-5 w-5 items-center justify-center rounded-full bg-warning text-[10px] font-semibold text-background"
            >
              {initial}
            </span>
            <span className="max-w-[136px] truncate text-[13px]">{name}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                open && "rotate-180",
              )}
              strokeWidth={2}
            />
          </>
        )}
      >
        <DropdownLabel>Workspace</DropdownLabel>
        <DropdownItem
          icon={<Check className="h-3.5 w-3.5 text-success" />}
          onClick={() => navigate("/workspace/settings")}
        >
          {name}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreateOpen(true)}>
          Create Workspace
        </DropdownItem>
        <DropdownItem
          icon={<Settings className="h-3.5 w-3.5" />}
          onClick={() => navigate("/workspace/settings")}
        >
          Workspace Settings
        </DropdownItem>
        {others.length === 0 ? (
          <DropdownItem icon={<LayoutGrid className="h-3.5 w-3.5" />} disabled>
            Switch Workspace
          </DropdownItem>
        ) : (
          <>
            <DropdownSeparator />
            <DropdownLabel>Switch Workspace</DropdownLabel>
            {others.map((item) => (
              <DropdownItem
                key={item.id}
                icon={
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-warning text-[9px] font-semibold text-background">
                    {item.initial}
                  </span>
                }
                onClick={() => {
                  void switchWorkspace(item.id).then(() => navigate("/"));
                }}
              >
                {item.name}
              </DropdownItem>
            ))}
          </>
        )}
      </Dropdown>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = await createWorkspace(trimmed);
      toast.success(`Workspace “${created.name}” created`);
      onOpenChange(false);
      setName("");
      navigate("/");
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
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            A workspace holds its own projects, team and billing. It starts on your
            current plan.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="ws-name" className="text-[12px] text-muted-foreground">
              Workspace name
            </label>
            <Input
              id="ws-name"
              value={name}
              autoFocus
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `+ New`. Every enabled entry lands on a working create flow. The three Render
 * service classes God Hosting cannot yet distinguish from a web service are shown
 * disabled rather than pointed at a flow that would quietly build something else.
 *
 * Exported so the Overview page's `+ New ▼` is the same menu; pass
 * `onNewProject` there to open the create-project modal in place.
 */
export function NewMenu({ onNewProject }: { onNewProject?: () => void } = {}) {
  const navigate = useNavigate();
  const { canWrite } = useWorkspace();
  // Creating from inside a project/environment carries the target along, so the
  // wizard opens with it locked instead of asking again (§14). From anywhere else
  // there is nothing to carry and the wizard lets the user choose.
  const { projectId, environmentId } = useHierarchyContext();
  const placement = deployQuery(projectId, environmentId);
  const extra = placement ? `&${placement.slice(1)}` : "";

  return (
    <Dropdown
      align="end"
      label="Create new"
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
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        disabled={!canWrite}
        onClick={() => (onNewProject ? onNewProject() : navigate("/projects?new=project"))}
      >
        New Project
      </DropdownItem>
      <DropdownSeparator />
      {/* Only the resource kinds God Hosting can actually create are listed (§10). */}
      <DropdownItem
        icon={<Network className="h-3.5 w-3.5" />}
        disabled={!canWrite}
        onClick={() => navigate(`/projects/new${placement}`)}
      >
        New Web Service
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<Database className="h-3.5 w-3.5" />}
        disabled={!canWrite}
        onClick={() => navigate(`/databases/new?engine=postgres${extra}`)}
      >
        New PostgreSQL
      </DropdownItem>
      <DropdownItem
        icon={<Database className="h-3.5 w-3.5" />}
        disabled={!canWrite}
        onClick={() => navigate(`/databases/new?engine=redis${extra}`)}
      >
        New Redis
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<Layers className="h-3.5 w-3.5" />}
        disabled={!canWrite}
        onClick={() => navigate("/blueprints?new=1")}
      >
        New Blueprint
      </DropdownItem>
    </Dropdown>
  );
}

/** Outlined `Upgrade` → billing. Hidden on the top tier, where it would lie. */
function UpgradeButton() {
  const { workspace } = useWorkspace();
  if (!workspace || workspace.plan.key === "scale") return null;
  return (
    <Link
      to="/billing"
      className="hidden h-8 items-center rounded-md border border-border px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary sm:inline-flex"
    >
      Upgrade
    </Link>
  );
}

function HelpMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const navigate = useNavigate();
  return (
    <Dropdown
      align="end"
      label="Help"
      triggerClassName="h-8 w-8 justify-center text-muted-foreground hover:bg-secondary hover:text-foreground"
      trigger={() => <CircleHelp className="h-4 w-4" strokeWidth={1.75} />}
    >
      <DropdownItem icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => navigate("/docs")}>
        Documentation
      </DropdownItem>
      <DropdownItem icon={<Keyboard className="h-3.5 w-3.5" />} onClick={onShortcuts}>
        Keyboard Shortcuts
      </DropdownItem>
      <DropdownItem icon={<LifeBuoy className="h-3.5 w-3.5" />} onClick={() => navigate("/docs")}>
        Contact Support
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<HeartPulse className="h-3.5 w-3.5" />}
        // `/status`, not `/system`: host metrics are admin-only, and this menu is
        // shown to every member.
        onClick={() => navigate("/status")}
      >
        Platform Status
      </DropdownItem>
    </Dropdown>
  );
}

/** Circular avatar menu. The glyph is the real account's initial. */
function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const initial = (user?.name?.trim()[0] || user?.email?.trim()[0] || "U").toUpperCase();

  return (
    <Dropdown
      align="end"
      label="Account menu"
      triggerClassName="h-8 w-8 justify-center"
      className="min-w-[236px]"
      trigger={() => (
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[12px] font-medium text-brand-foreground"
        >
          {initial}
        </span>
      )}
    >
      <div className="px-3 pb-1.5 pt-2">
        <div className="truncate text-[13px] text-foreground">{user?.name || "Account"}</div>
        <div className="truncate text-[11px] text-subtle">{user?.email}</div>
      </div>
      <DropdownSeparator />
      <DropdownItem
        icon={<UserIcon className="h-3.5 w-3.5" />}
        onClick={() => navigate("/settings?tab=profile")}
      >
        Profile
      </DropdownItem>
      <DropdownItem
        icon={<Settings className="h-3.5 w-3.5" />}
        onClick={() => navigate("/settings")}
      >
        Account Settings
      </DropdownItem>
      <DropdownItem
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        onClick={() => navigate("/workspace/settings")}
      >
        Workspace Settings
      </DropdownItem>
      <DropdownItem
        icon={<CreditCard className="h-3.5 w-3.5" />}
        onClick={() => navigate("/billing")}
      >
        Billing
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem icon={<Keyboard className="h-3.5 w-3.5" />} onClick={onShortcuts}>
        Keyboard Shortcuts
      </DropdownItem>
      <DropdownItem icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => navigate("/docs")}>
        Documentation
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<LogOut className="h-3.5 w-3.5" />}
        onClick={logout}
        className="text-danger hover:bg-danger-surface"
      >
        Sign Out
      </DropdownItem>
    </Dropdown>
  );
}

/** Only the shortcuts the shell actually binds (see ShellContext). */
function ShortcutsDialog({
  open,
  onOpenChange,
  modKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modKey: string;
}) {
  const rows: Array<[string, string]> = [
    [`${modKey}K`, "Open or close search"],
    ["/", "Open search"],
    ["↑ ↓", "Move through search results"],
    ["Enter", "Go to the selected result"],
    ["Esc", "Close search, menus and the navigation drawer"],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="divide-y divide-border">
          {rows.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-[13px] text-muted-foreground">{label}</dt>
              <dd>
                <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
