// The admin panel's own shell — the whole point of the separate-app split.
//
// It is NOT `AppShell` with a different rail. Three things are deliberately
// absent:
//
//   • `WorkspaceProvider` — nothing in here belongs to a workspace, and mounting
//     it would have the panel picking a "current workspace" it never uses and
//     polling `/api/workspaces` on every admin page.
//   • `MaintenanceGate` — maintenance mode exists so customers see a closed sign
//     *while an operator fixes the platform*. Gating this shell would lock the
//     operator out of the only surface that can turn it back off (spec §33).
//   • `CommandPalette` — it searches projects and services, which are tenant
//     objects. An admin palette is its own thing and does not exist yet.
//
// The geometry is shared on purpose: same `--shell-topbar`, same `shell-rail`
// and `shell-inset`, so switching surfaces does not move the page under you.

import { useRef } from "react";
import { Outlet } from "react-router-dom";
import { AlertCircle, Loader2, ShieldOff } from "lucide-react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminTopHeader } from "@/components/admin/AdminTopHeader";
import { ShellProvider, useShell } from "@/components/shell/ShellContext";
import { RouteProgress, RouteTransition } from "@/components/shell/RouteTransition";
import { Button } from "@/components/ui/button";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/lib/focusTrap";

function AdminFrame() {
  const { mobileOpen, setMobileOpen } = useShell();
  const mobileDrawerRef = useRef<HTMLElement>(null);

  useFocusTrap(mobileOpen, mobileDrawerRef);

  return (
    <div className="min-h-screen bg-background">
      <RouteProgress />
      <AdminTopHeader />

      <aside className="shell-rail fixed bottom-0 left-0 top-[var(--shell-topbar)] z-30 hidden lg:block">
        <AdminSidebar variant="desktop" />
      </aside>

      <div
        className={cn(
          "fixed inset-0 z-50 bg-foreground/40 transition-opacity duration-200 lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobileOpen(false)}
        aria-hidden={!mobileOpen}
      />
      <aside
        ref={mobileDrawerRef}
        className={cn(
          "shell-rail fixed inset-y-0 left-0 z-[60] max-w-[85vw] transition-transform duration-200 ease-out lg:hidden",
          mobileOpen ? "visible translate-x-0" : "invisible -translate-x-full",
        )}
        aria-hidden={!mobileOpen}
      >
        <AdminSidebar variant="mobile" />
      </aside>

      <div className="shell-inset">
        <main className="w-full px-4 py-6 sm:px-6 lg:px-8">
          <AdminAccessGate>
            <RouteTransition>
              <Outlet />
            </RouteTransition>
          </AdminAccessGate>
        </main>
      </div>
    </div>
  );
}

/**
 * What the panel shows before `/api/admin/me` has answered, and what it shows if
 * the answer is "no".
 *
 * The distinction that matters (spec §52): a *failed* `/me` is not the same as an
 * empty permission list. Treating them alike would render a fully-privileged
 * operator's panel as an access-denied page whenever the API hiccups, so the
 * error path offers a retry and says what broke.
 */
function AdminAccessGate({ children }: { children: React.ReactNode }) {
  const { me, loading, error, ready, reload } = useAdminMe();

  if (!ready && loading) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-brand" strokeWidth={2} />
        <p className="text-[13px] text-muted-foreground">Checking your admin access…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-surface text-danger">
          <AlertCircle className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div>
          <h1 className="text-[15px] font-medium text-foreground">Could not load your admin profile</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" size="sm" className="press" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  // Answered, and the answer is that this account holds no admin role. The rail
  // is already empty in this case; without this the operator would face a blank
  // page and no explanation.
  if (ready && me && me.permissions.length === 0) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <ShieldOff className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div>
          <h1 className="text-[15px] font-medium text-foreground">No admin access</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {me.email ? <span className="font-medium text-foreground">{me.email}</span> : "This account"}{" "}
            has no admin role on this platform. Ask an owner to grant one.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AdminShell() {
  return (
    <ShellProvider>
      <AdminFrame />
    </ShellProvider>
  );
}

export default AdminShell;
