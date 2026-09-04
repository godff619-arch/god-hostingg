// Operator maintenance window (Admin → Settings → Maintenance mode).
//
// The backend refuses the tenant API with `503 {maintenance: true}` while the
// window is open, and `lib/auth.ts` funnels that one status into here. Two
// outcomes, matching what the switch promises:
//
//   • a normal user gets a maintenance page instead of a broken dashboard full
//     of failed requests — carrying the operator's own message, verbatim;
//   • an operator gets a banner and keeps working, because the ops center stays
//     reachable and someone has to be able to turn the window off again.
//
// The gate wraps the shell so the page replaces it entirely (no rail, no header
// full of dead menus), while `<MaintenanceBanner />` renders inside the shell
// where it belongs. Hence the split: one component owns the state, the other
// reads it from context.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { Hammer, RefreshCw, Wrench } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { registerMaintenanceHandler } from "@/lib/auth";
import { hasAdminAccess } from "@/lib/roles";

const FALLBACK_MESSAGE =
  "The platform is temporarily unavailable for maintenance. Please try again shortly.";

/** The live maintenance message, or null when the platform is open. */
const MaintenanceContext = createContext<string | null>(null);

export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    registerMaintenanceHandler((text) => setMessage(text || FALLBACK_MESSAGE));
    // The shell is the only consumer, but unregister anyway so a signed-out
    // remount cannot leave a handler pointing at a dead component.
    return () => registerMaintenanceHandler(() => {});
  }, []);

  // Unmounting the shell also stops everything under it from retrying against
  // an API that is refusing on purpose.
  if (message && !hasAdminAccess(user?.role)) {
    return <MaintenancePage message={message} />;
  }

  return <MaintenanceContext.Provider value={message}>{children}</MaintenanceContext.Provider>;
}

/**
 * Rendered inside the shell (above the routed page) so an operator working
 * through a maintenance window can see, from any page, that it is still open.
 */
export function MaintenanceBanner() {
  const message = useContext(MaintenanceContext);
  if (!message) return null;

  return (
    <div className="sticky top-[var(--shell-topbar)] z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning-border bg-warning-surface px-4 py-2 text-[12px] sm:px-6 lg:px-8">
      <span className="flex shrink-0 items-center gap-1.5 font-semibold text-warning">
        <Wrench className="h-3.5 w-3.5" strokeWidth={2} />
        Maintenance mode is on
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{message}</span>
      <Link
        to="/admin/settings"
        className="shrink-0 font-medium text-warning underline decoration-warning/40 underline-offset-2 transition-colors hover:decoration-warning"
      >
        Turn off
      </Link>
    </div>
  );
}

function MaintenancePage({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl border border-warning-border bg-warning-surface">
          <Hammer className="h-7 w-7 text-warning" strokeWidth={1.75} />
        </span>
        <h1 className="text-2xl font-bold tracking-tight">Down for maintenance</h1>
        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
        <p className="mt-4 text-xs text-subtle">
          Your deployed services keep running — only this dashboard is paused.
        </p>
        {/* A reload is the honest retry: `/api/health` is exempt from the gate, so
            polling it would report "open" the entire time the window is on. */}
        <Button className="mt-8" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4" strokeWidth={2} />
          Try again
        </Button>
      </div>
    </div>
  );
}
