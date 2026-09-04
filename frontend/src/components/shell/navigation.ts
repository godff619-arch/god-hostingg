// Single source of truth for shell navigation — the sidebar, breadcrumbs and
// search modal all read from here so a new page only has to be added once.
//
// The first four groups reproduce the Render rail exactly and in order:
//   Projects · Blueprints · Environment Groups
//   INTEGRATIONS → Observability · Webhooks · Notifications
//   NETWORKING   → Private Links · Dedicated IPs
//   WORKSPACE    → Billing · Settings
// The PLATFORM and ADMIN groups below are operator-only surfaces (host metrics,
// container logs, shell, plans…) and are hidden from ordinary members.

import type { ComponentType } from "react";
import {
  Activity,
  Anchor,
  Archive,
  Bell,
  BookOpen,
  Blocks,
  CreditCard,
  Database,
  Gauge,
  Layers,
  LayoutGrid,
  Link2,
  Network,
  Rocket,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  TriangleAlert,
  Users,
  Webhook,
} from "lucide-react";

/** lucide-react ships untyped here, so icons are described structurally. */
export type IconComponent = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

export interface NavChild {
  label: string;
  href: string;
  icon: IconComponent;
  description?: string;
}

export interface NavItem {
  label: string;
  href: string;
  icon: IconComponent;
  description: string;
  /**
   * Path prefixes that keep this rail item selected (section pages).
   * Default: the item `href` (and nested paths under it).
   */
  section?: string[];
  /** Opens outside the app shell (e.g. docs site). */
  external?: boolean;
  /** Collapsible tree children. */
  children?: NavChild[];
  /**
   * Hidden from the read-only `viewer` tier. For destinations a viewer is refused
   * outright rather than shown read-only — currently the server terminal, whose
   * shell is root in the panel container.
   */
  fullAdminOnly?: boolean;
}

export interface NavGroup {
  /** Empty label ⇒ the group renders with no uppercase heading (top block). */
  label: string;
  items: NavItem[];
  /** Group is only shown to admins (client-side cosmetic gate; server enforces). */
  adminOnly?: boolean;
}

export const navGroups: NavGroup[] = [
  {
    label: "",
    items: [
      {
        label: "Projects",
        href: "/projects",
        icon: LayoutGrid,
        description: "Every project in this workspace",
        // Everything in the hierarchy lives under `/projects`; `/project/:id` is
        // the old single-project URL, kept alive by a redirect.
        section: ["/", "/projects", "/project"],
      },
      {
        label: "Blueprints",
        href: "/blueprints",
        icon: Blocks,
        description: "Infrastructure as code",
        section: ["/blueprints"],
      },
      {
        label: "Environment Groups",
        href: "/environment-groups",
        icon: Layers,
        description: "Shared environment variables",
        section: ["/environment-groups"],
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        label: "Observability",
        href: "/observability",
        icon: Activity,
        description: "Stream metrics and logs out",
        section: ["/observability"],
      },
      {
        label: "Webhooks",
        href: "/webhooks",
        icon: Webhook,
        description: "Notify your systems on events",
        section: ["/webhooks"],
      },
      {
        label: "Notifications",
        href: "/notifications",
        icon: Bell,
        description: "Where alerts are delivered",
        section: ["/notifications"],
      },
    ],
  },
  {
    label: "Networking",
    items: [
      {
        label: "Private Links",
        href: "/private-links",
        icon: Link2,
        description: "Private connectivity to your services",
        section: ["/private-links"],
      },
      {
        label: "Dedicated IPs",
        href: "/dedicated-ips",
        icon: Network,
        description: "Static outbound addresses",
        section: ["/dedicated-ips"],
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        label: "Billing",
        href: "/billing",
        icon: CreditCard,
        description: "Plan, usage and invoices",
        section: ["/billing", "/workspace"],
      },
      {
        label: "Settings",
        href: "/workspace/settings",
        icon: Settings,
        description: "Workspace, team and security",
        section: ["/workspace/settings"],
      },
    ],
  },
  {
    label: "Platform",
    adminOnly: true,
    items: [
      {
        label: "Databases",
        href: "/databases",
        icon: Database,
        description: "Managed data services",
        section: ["/databases"],
      },
      {
        label: "Ports",
        href: "/ports",
        icon: Anchor,
        description: "Allocated and free host ports",
        section: ["/ports"],
      },
      {
        label: "System",
        href: "/system",
        icon: Gauge,
        description: "CPU, memory and disk pressure",
        section: ["/system"],
      },
      {
        label: "Logs",
        href: "/logs",
        icon: ScrollText,
        description: "Live output from every service",
        section: ["/logs"],
      },
      {
        label: "Terminal",
        href: "/terminal",
        icon: SquareTerminal,
        description: "Interactive shell on the server",
        section: ["/terminal"],
        fullAdminOnly: true,
      },
      {
        label: "Docs",
        href: "/docs",
        icon: BookOpen,
        description: "Guides and commands",
        section: ["/docs"],
      },
    ],
  },
  {
    label: "Admin",
    adminOnly: true,
    items: [
      {
        label: "Overview",
        href: "/admin",
        icon: ShieldCheck,
        description: "Platform-wide health and activity",
        section: ["/admin"],
      },
      {
        label: "Operations",
        href: "/admin/operations",
        icon: Activity,
        description: "Live control-plane, database and Docker health",
        section: ["/admin/operations"],
      },
      {
        label: "Users",
        href: "/admin/users",
        icon: Users,
        description: "Manage every account",
        section: ["/admin/users"],
      },
      {
        label: "Applications",
        href: "/admin/apps",
        icon: LayoutGrid,
        description: "Every app across all tenants",
        section: ["/admin/apps"],
      },
      {
        label: "Deployments",
        href: "/admin/deployments",
        icon: Rocket,
        description: "Platform-wide deployment history",
        section: ["/admin/deployments"],
      },
      {
        label: "Uploads",
        href: "/admin/uploads",
        icon: Archive,
        description: "Archived user ZIP uploads",
        section: ["/admin/uploads"],
      },
      {
        label: "Errors",
        href: "/admin/errors",
        icon: TriangleAlert,
        description: "Grouped platform failures",
        section: ["/admin/errors"],
      },
      {
        label: "Plans",
        href: "/admin/plans",
        icon: CreditCard,
        description: "Quota tiers and pricing",
        section: ["/admin/plans"],
      },
      {
        label: "Settings",
        href: "/admin/settings",
        icon: SlidersHorizontal,
        description: "Platform configuration",
        section: ["/admin/settings"],
      },
    ],
  },
];

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items);

/** Nav groups visible to the current role. Admin groups are hidden from non-admins
 *  (cosmetic only — the server's requireAdmin is the real gate).
 *
 *  `fullAdmin` defaults to `isAdmin`, so the two only diverge for the read-only
 *  `viewer` tier — the one role that reaches the admin area but must not see
 *  `fullAdminOnly` destinations. */
export function visibleNavGroups(isAdmin: boolean, fullAdmin = isAdmin): NavGroup[] {
  return navGroups
    .filter((group) => !group.adminOnly || isAdmin)
    .map((group) =>
      group.items.some((item) => item.fullAdminOnly) && !fullAdmin
        ? { ...group, items: group.items.filter((item) => !item.fullAdminOnly) }
        : group,
    );
}

/** Nav items visible to the current role (flattened). Used by the search modal. */
export function visibleNavItems(isAdmin: boolean, fullAdmin = isAdmin): NavItem[] {
  return visibleNavGroups(isAdmin, fullAdmin).flatMap((group) => group.items);
}

/** True when `pathname` is exactly `prefix` or nested under it. */
function pathInSection(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Highlight a rail item for its whole section (list + nested create/detail),
 * not only the exact `href`. Longest match wins, so `/workspace/settings` does
 * not also light up Billing's `/workspace` prefix.
 */
export function isNavActive(pathname: string, item: NavItem): boolean {
  const own = matchLength(pathname, item);
  if (own === null) return false;
  return !navItems.some((other) => {
    if (other === item) return false;
    const len = matchLength(pathname, other);
    return len !== null && len > own;
  });
}

/** Length of the longest section prefix of `item` that matches, or null. */
function matchLength(pathname: string, item: NavItem): number | null {
  const prefixes = item.section?.length ? item.section : [item.href];
  let best: number | null = null;
  for (const prefix of prefixes) {
    if (!pathInSection(pathname, prefix)) continue;
    if (best === null || prefix.length > best) best = prefix.length;
  }
  return best;
}

/** The nav entry that owns the current URL, including nested pages. */
export function activeNavItem(pathname: string): NavItem | undefined {
  return navItems.find((item) => isNavActive(pathname, item));
}

const segmentLabels: Record<string, string> = {
  projects: "Projects",
  project: "Projects",
  new: "New",
  blueprints: "Blueprints",
  "environment-groups": "Environment Groups",
  observability: "Observability",
  webhooks: "Webhooks",
  notifications: "Notifications",
  "private-links": "Private Links",
  "dedicated-ips": "Dedicated IPs",
  billing: "Billing",
  workspace: "Workspace",
  databases: "Databases",
  ports: "Ports",
  system: "System",
  logs: "Logs",
  terminal: "Terminal",
  settings: "Settings",
  docs: "Docs",
  admin: "Admin",
  operations: "Operations",
  users: "Users",
  apps: "Applications",
  deployments: "Deployments",
  plans: "Plans",
  uploads: "Uploads",
  errors: "Errors",
};

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Names for the ids in the current URL. Ids are not human labels, so the shell
 * resolves the project and environment names once (cheap nav endpoint) and passes
 * them in; anything still unknown falls back to a generic word rather than
 * printing `prj-9f3a21c4b7e0` at the user.
 */
export interface HierarchyLabels {
  projectName?: string | null;
  environmentName?: string | null;
}

/**
 * Breadcrumb trail for the top bar.
 *
 * The project hierarchy gets an explicit branch so the trail reads
 * `Projects / My project / Production / api` — the `environments` and `services`
 * URL segments are plumbing and are never shown. Every crumb except the last is
 * a link, so the trail doubles as the way back up (§6).
 */
export function breadcrumbsFor(
  pathname: string,
  leafLabel?: string,
  hierarchy?: HierarchyLabels,
): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Projects" }];

  if (segments[0] === "settings") {
    const crumbs: Crumb[] = [{ label: "Settings", href: "/settings" }];
    if (leafLabel) crumbs.push({ label: leafLabel });
    return crumbs;
  }

  if (segments[0] === "projects") return projectCrumbs(segments, leafLabel, hierarchy);

  const crumbs: Crumb[] = [];
  segments.forEach((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join("/")}`;
    const isLast = index === segments.length - 1;
    const known = segmentLabels[segment];
    const label = known || (isLast && leafLabel) || titleize(segment);
    crumbs.push({ label, href: isLast ? undefined : href });
  });
  return crumbs;
}

/** Projects → Project → Environment → Service, with the plumbing segments dropped. */
function projectCrumbs(
  segments: string[],
  leafLabel?: string,
  hierarchy?: HierarchyLabels,
): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Projects", href: "/projects" }];
  if (segments.length === 1) return [{ label: "Projects" }];
  if (segments[1] === "new") {
    crumbs.push({ label: "New Service" });
    return crumbs;
  }

  const projectHref = `/projects/${segments[1]}`;
  const projectLast = segments.length === 2;
  crumbs.push({
    label: hierarchy?.projectName || (projectLast && leafLabel) || "Project",
    href: projectLast ? undefined : projectHref,
  });
  if (projectLast) return crumbs;

  if (segments[2] === "settings") {
    crumbs.push({ label: "Settings" });
    return crumbs;
  }

  if (segments[2] !== "environments" || !segments[3]) {
    // Unknown tail under a project — title-case it rather than dropping it.
    segments.slice(2).forEach((segment, index) => {
      const isLast = index === segments.length - 3;
      crumbs.push({
        label: segmentLabels[segment] || (isLast && leafLabel) || titleize(segment),
        href: isLast ? undefined : `/${segments.slice(0, index + 3).join("/")}`,
      });
    });
    return crumbs;
  }

  const environmentHref = `${projectHref}/environments/${segments[3]}`;
  const environmentLast = segments.length === 4;
  crumbs.push({
    label: hierarchy?.environmentName || (environmentLast && leafLabel) || "Environment",
    href: environmentLast ? undefined : environmentHref,
  });
  if (environmentLast) return crumbs;

  if (segments[4] === "services" && segments[5]) {
    crumbs.push({ label: leafLabel || "Service" });
  }
  return crumbs;
}

function titleize(segment: string): string {
  const readable = segment.replace(/[-_]/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}
