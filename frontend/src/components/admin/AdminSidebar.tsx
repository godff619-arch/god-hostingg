// The admin panel's left rail — same 228px dark plane and `sidebar-*` tokens as
// the tenant rail so the product still feels like one product, but a different
// tree and a different footer.
//
// Two things make it visibly the admin panel rather than the app: the header
// carries the operator's actual role (read from `/api/admin/me`, so a `viewer`
// sees "Read-only") and the footer's primary action is the way back out to the
// customer-facing app. Both matter because everything in here is platform-wide —
// an operator who forgets which surface they are on deletes a real tenant.

import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, LayoutGrid, LifeBuoy, ShieldCheck, X } from "lucide-react";
import { useShell } from "@/components/shell/ShellContext";
import {
  isAdminNavActive,
  visibleAdminNav,
  type AdminNavItem,
} from "@/components/admin/adminNavigation";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";

export function AdminSidebar({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const { pathname } = useLocation();
  const { setMobileOpen } = useShell();
  const { me, can, loading } = useAdminMe();
  const groups = visibleAdminNav(can);
  const isMobile = variant === "mobile";
  const close = () => {
    if (isMobile) setMobileOpen(false);
  };

  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
        <Link to="/admin" onClick={close} className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium leading-tight">
              Admin panel
            </span>
            {/* The live role, not a hardcoded "Administrator" — a read-only
                viewer must be able to see that is what they are. */}
            <span className="block truncate text-[10px] leading-tight text-sidebar-subtle">
              {loading ? "…" : me?.role_label || "No admin role"}
            </span>
          </span>
        </Link>
        {isMobile ? (
          <button
            type="button"
            onClick={close}
            aria-label="Close navigation"
            className="shrink-0 rounded-md p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <nav className="shell-scroll flex-1 overflow-y-auto px-2 py-3">
        {loading && groups.length === 0 ? (
          <RailSkeleton />
        ) : (
          groups.map((group, index) => (
            // Keyed by position for the same reason as the tenant rail: a label is
            // display text, not an identity.
            <div key={`${index}-${group.label}`} className={index === 0 ? "" : "mt-5"}>
              {group.label ? (
                <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.09em] text-sidebar-subtle">
                  {group.label}
                </div>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <AdminRailLink
                      item={item}
                      active={isAdminNavActive(pathname, item)}
                      onNavigate={close}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-2 py-2">
        <Link
          to="/projects"
          onClick={close}
          className="press flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          Back to the app
        </Link>
        <Link
          to="/docs"
          onClick={close}
          className="flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <LifeBuoy className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          Docs
        </Link>
        <Link
          to="/status"
          onClick={close}
          className="flex items-center gap-2 rounded-md px-2 py-[6px] text-[12px] text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <LayoutGrid className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          Public status page
        </Link>
      </div>
    </div>
  );
}

function AdminRailLink({
  item,
  active,
  onNavigate,
}: {
  item: AdminNavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      title={item.description}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] transition-colors",
        active
          ? "bg-brand text-brand-foreground"
          : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/**
 * The rail is permission-filtered, so it cannot be drawn until `/me` answers.
 * Placeholder rows keep the layout still instead of letting the whole tree pop in
 * (spec §52).
 */
function RailSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="h-[30px] animate-pulse rounded-md bg-sidebar-accent/60" />
      ))}
    </div>
  );
}
