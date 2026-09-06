// Authenticated application shell: fixed 228px left rail, 48px sticky header and
// the routed page. Below `lg` the rail becomes an overlay drawer. The rail is
// fixed rather than a flex column so the document keeps its normal scroll
// behaviour (sticky page elements, xterm sizing).

import { useRef } from "react";
import { Outlet } from "react-router-dom";
import { AnnouncementBanner } from "@/components/shell/AnnouncementBanner";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { MaintenanceBanner, MaintenanceGate } from "@/components/shell/MaintenanceGate";
import { Sidebar } from "@/components/shell/Sidebar";
import { ShellProvider, useShell } from "@/components/shell/ShellContext";
import { RouteProgress, RouteTransition } from "@/components/shell/RouteTransition";
import { TopHeader } from "@/components/shell/TopHeader";
import { WorkspaceProvider } from "@/components/workspace/WorkspaceProvider";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/lib/focusTrap";

function ShellFrame() {
  const { mobileOpen, setMobileOpen } = useShell();
  const mobileDrawerRef = useRef<HTMLElement>(null);

  useFocusTrap(mobileOpen, mobileDrawerRef);

  return (
    <div className="min-h-screen bg-background">
      <RouteProgress />
      {/* Full-width 48px header; the rail starts directly below it (spec §7). */}
      <TopHeader />

      <aside className="shell-rail fixed bottom-0 left-0 top-[var(--shell-topbar)] z-30 hidden lg:block">
        <Sidebar variant="desktop" />
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
          // `invisible` keeps the closed drawer out of the tab order.
          mobileOpen ? "visible translate-x-0" : "invisible -translate-x-full",
        )}
        aria-hidden={!mobileOpen}
      >
        <Sidebar variant="mobile" />
      </aside>

      <div className="shell-inset">
        <MaintenanceBanner />
        <AnnouncementBanner />
        <main className="w-full px-4 py-6 sm:px-6 lg:px-8">
          <RouteTransition>
            <Outlet />
          </RouteTransition>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

export function AppShell() {
  return (
    <ShellProvider>
      {/* Outside WorkspaceProvider: when the gate takes over for a normal user it
          unmounts everything below, so nothing keeps polling an API that is
          refusing by design. */}
      <MaintenanceGate>
        <WorkspaceProvider>
          <ShellFrame />
        </WorkspaceProvider>
      </MaintenanceGate>
    </ShellProvider>
  );
}
