// The admin panel's 48px header. Same geometry as the tenant one, different
// contents: no workspace selector (nothing here is workspace-scoped), no "+ New"
// (an operator does not create their own projects from this surface), and a
// breadcrumb built from the admin tree.
//
// The one addition is the maintenance indicator. When maintenance mode is on,
// customers see the maintenance page and admins keep working — so the admin needs
// a standing reminder that the platform is closed, or it stays closed all night.

import { Fragment } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Menu,
  ShieldCheck,
  User as UserIcon,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { adminCrumbs } from "@/components/admin/adminNavigation";
import { useShell } from "@/components/shell/ShellContext";
import { useAdminMe } from "@/hooks/useAdminMe";
import { ThemeToggle } from "@/components/ThemeToggle";

export function AdminTopHeader() {
  const { pathname } = useLocation();
  const { setMobileOpen } = useShell();
  const crumbs = adminCrumbs(pathname);

  return (
    <header className="sticky top-0 z-40 flex h-[var(--shell-topbar)] items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
      >
        <Menu className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <Link to="/admin" className="flex shrink-0 items-center gap-2 lg:hidden">
        <ShieldCheck className="h-4 w-4 text-brand" strokeWidth={2} />
        <span className="text-[13px] font-medium">Admin</span>
      </Link>

      <nav
        aria-label="Breadcrumb"
        className="hidden min-w-0 flex-1 items-center gap-1 text-[13px] lg:flex"
      >
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" strokeWidth={1.75} />
            )}
            {crumb.href ? (
              <Link
                to={crumb.href}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-foreground">{crumb.label}</span>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ThemeToggle />
        <MaintenanceIndicator />
        <Link
          to="/projects"
          className="press hidden h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Exit admin
        </Link>
        <AdminUserMenu />
      </div>
    </header>
  );
}

/**
 * Standing reminder that the platform is closed to customers.
 *
 * Only visible while the window is open, and it links to the switch that closes
 * it. The tenant shell learns about maintenance from a 503 on its own API; the
 * admin API is exempt from that gate by design, so the panel would otherwise have
 * no way of knowing — an operator could flip the switch, get distracted, and leave
 * every customer looking at the maintenance page overnight.
 */
function MaintenanceIndicator() {
  const { me } = useAdminMe();
  if (!me?.platform?.maintenance_mode) return null;

  return (
    <Link
      to="/admin/settings"
      title={me.platform.maintenance_message || "Maintenance mode is on"}
      className="press flex h-8 items-center gap-1.5 rounded-lg border border-warning-border bg-warning-surface px-2.5 text-xs font-medium text-warning transition-colors hover:brightness-95"
    >
      <Wrench className="h-3.5 w-3.5" strokeWidth={2} />
      <span className="hidden sm:inline">Maintenance mode on</span>
      <span className="sm:hidden">Maintenance</span>
    </Link>
  );
}

function AdminUserMenu() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { me } = useAdminMe();
  const initial = (me?.name?.trim()[0] || me?.email?.trim()[0] || "A").toUpperCase();

  return (
    <Dropdown
      align="end"
      label="Account menu"
      triggerClassName="h-8 w-8 justify-center"
      className="min-w-[240px]"
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
        <div className="truncate text-[13px] text-foreground">{me?.name || "Admin"}</div>
        <div className="truncate text-[11px] text-subtle">{me?.email}</div>
        <div className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-brand-ring/40 bg-brand-ring/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
          <ShieldCheck className="h-2.5 w-2.5" strokeWidth={2} />
          {me?.role_label || "Admin"}
        </div>
        {/* Where the last sign-in came from. An operator who sees an address they
            do not recognise has a compromised account, not a UI curiosity. */}
        {me?.last_login_ip ? (
          <div className="mt-1.5 truncate font-mono text-[10px] text-subtle">
            Last sign-in from {me.last_login_ip}
          </div>
        ) : null}
      </div>
      <DropdownSeparator />
      <DropdownItem
        icon={<UserIcon className="h-3.5 w-3.5" />}
        onClick={() => navigate("/settings?tab=profile")}
      >
        My profile
      </DropdownItem>
      <DropdownItem
        icon={<ArrowLeft className="h-3.5 w-3.5" />}
        onClick={() => navigate("/projects")}
      >
        Back to the app
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        icon={<LogOut className="h-3.5 w-3.5" />}
        onClick={logout}
        className="text-danger hover:bg-danger-surface"
      >
        Sign out
      </DropdownItem>
    </Dropdown>
  );
}
