// The admin panel's own rail.
//
// Deliberately separate from `shell/navigation.ts`: the tenant rail is scoped to a
// workspace and lists what a customer owns, while this one is platform-wide and
// lists what an operator runs. Mixing them is what produced the old single rail
// with an "Admin" group bolted on the bottom — a customer's Projects link and a
// destructive platform switch one keystroke apart.
//
// Every entry names the `permission` the API requires for its landing page, so a
// `billing_admin` never sees a Domains link that would answer 403. The gate is
// cosmetic; `adminPermissionGate` on the server is the real one.
//
// An entry only exists once its page does. A rail item that leads to a stub is
// worse than no item at all.

import type { ComponentType } from "react";
import {
  Activity,
  Archive,
  Banknote,
  Boxes,
  ChartLine,
  CreditCard,
  FileText,
  Globe,
  LayoutGrid,
  LifeBuoy,
  Lock,
  Mail,
  Megaphone,
  Repeat,
  Rocket,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Tags,
  TicketPercent,
  ToggleLeft,
  TriangleAlert,
  Undo2,
  Users,
  Wallet,
} from "lucide-react";
import type { AdminPermission } from "@/hooks/useAdminMe";

/**
 * lucide-react's own `LucideIcon` is a namespace in this build, so icons are
 * described structurally — the same shape `shell/navigation.ts` uses.
 */
export type AdminNavIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

export interface AdminNavItem {
  label: string;
  href: string;
  icon: AdminNavIcon;
  /** One line, used as the rail tooltip and in the command palette. */
  description: string;
  /** Server-side permission this page needs. Omitted ⇒ any admin tier. */
  permission?: AdminPermission;
  /** Extra path prefixes that keep the item selected (detail pages). */
  section?: string[];
}

export interface AdminNavGroup {
  /** Empty label ⇒ no uppercase heading (the top block). */
  label: string;
  items: AdminNavItem[];
}

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "",
    items: [
      {
        label: "Overview",
        href: "/admin",
        icon: ShieldCheck,
        description: "Platform-wide health and activity",
      },
      {
        label: "Operations",
        href: "/admin/operations",
        icon: Activity,
        description: "Control-plane, database and Docker health",
      },
    ],
  },
  {
    label: "Customers",
    items: [
      {
        label: "Users",
        href: "/admin/users",
        icon: Users,
        description: "Every account, plan and session",
        permission: "users.view",
        section: ["/admin/users"],
      },
      {
        label: "Workspaces",
        href: "/admin/workspaces",
        icon: Boxes,
        description: "Accounts, their projects and their teams",
        permission: "workspaces.view",
        section: ["/admin/workspaces"],
      },
    ],
  },
  {
    label: "Communications",
    items: [
      {
        label: "Email",
        href: "/admin/email",
        icon: Mail,
        description: "Mail server, templates and every mail attempted",
        permission: "email.view",
      },
      {
        label: "Announcements",
        href: "/admin/announcements",
        icon: Megaphone,
        description: "Banners, modals and inbox notices",
        permission: "email.view",
      },
      {
        label: "Support",
        href: "/admin/support",
        icon: LifeBuoy,
        description: "Customer tickets, replies and internal notes",
        permission: "support.view",
      },
    ],
  },
  {
    label: "Money",
    items: [
      {
        label: "Billing Analytics",
        href: "/admin/billing-analytics",
        icon: ChartLine,
        description: "MRR, churn, conversion and collected revenue",
        permission: "billing.view",
      },
      {
        label: "Plans",
        href: "/admin/plans",
        icon: Tags,
        description: "Quota tiers and pricing",
        permission: "billing.view",
      },
      {
        label: "Subscriptions",
        href: "/admin/subscriptions",
        icon: Repeat,
        description: "What each account is sold and entitled to",
        permission: "billing.view",
      },
      {
        label: "Payments",
        href: "/admin/payments",
        icon: Banknote,
        description: "Charges, refunds and failures",
        permission: "payments.view",
      },
      {
        label: "Refunds",
        href: "/admin/refunds",
        icon: Undo2,
        description: "Money given back, and who authorised it",
        permission: "payments.view",
      },
      {
        label: "Invoices",
        href: "/admin/invoices",
        icon: FileText,
        description: "Billing documents and what is owed",
        permission: "billing.view",
      },
      {
        label: "Credits",
        href: "/admin/credits",
        icon: Wallet,
        description: "Wallet balances and every movement",
        permission: "billing.view",
      },
      {
        label: "Cards on file",
        href: "/admin/cards",
        icon: CreditCard,
        description: "Saved payment methods, masked",
        permission: "billing.view",
      },
      {
        label: "Coupons",
        href: "/admin/coupons",
        icon: TicketPercent,
        description: "Discount codes and who redeemed them",
        permission: "billing.view",
      },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      {
        label: "Applications",
        href: "/admin/apps",
        icon: LayoutGrid,
        description: "Every app across all tenants",
        permission: "apps.view",
      },
      {
        label: "Deployments",
        href: "/admin/deployments",
        icon: Rocket,
        description: "Platform-wide deployment history",
        permission: "deployments.view",
      },
      {
        label: "Domains & DNS",
        href: "/admin/domains",
        icon: Globe,
        description: "Base domain, subdomains, SSL and DNS",
        permission: "domains.view",
      },
      {
        label: "Terminal",
        href: "/admin/terminal",
        icon: SquareTerminal,
        description: "Interactive shell on the server",
        permission: "terminal.access",
      },
    ],
  },
  {
    label: "Observability",
    items: [
      {
        label: "Audit Logs",
        href: "/admin/audit-logs",
        icon: ScrollText,
        description: "Who did what, and from where",
        permission: "audit.view",
      },
      {
        label: "Errors",
        href: "/admin/errors",
        icon: TriangleAlert,
        description: "Grouped platform failures",
        permission: "errors.view",
      },
      {
        label: "Uploads",
        href: "/admin/uploads",
        icon: Archive,
        description: "Archived user ZIP uploads",
        permission: "uploads.manage",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Security",
        href: "/admin/security",
        icon: Lock,
        description: "Sign-in attempts, live sessions and API keys",
        permission: "security.view",
      },
      {
        label: "Feature Flags",
        href: "/admin/feature-flags",
        icon: ToggleLeft,
        description: "Turn platform capabilities on or off",
        permission: "features.manage",
      },
      {
        label: "Settings",
        href: "/admin/settings",
        icon: SlidersHorizontal,
        description: "Platform configuration",
        permission: "settings.view",
      },
    ],
  },
];

/**
 * Groups this admin may use. A group with nothing left in it disappears rather
 * than rendering an empty heading — a `support_admin` should not be shown the
 * word "Infrastructure" with a blank space under it.
 */
export function visibleAdminNav(
  can: (permission: AdminPermission) => boolean,
): AdminNavGroup[] {
  return adminNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.permission || can(item.permission)),
    }))
    .filter((group) => group.items.length > 0);
}

export const adminNavItems: AdminNavItem[] = adminNavGroups.flatMap((g) => g.items);

/** True when `pathname` is exactly `prefix` or nested under it. */
function inSection(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Length of the longest matching prefix for `item`, or null when none match. */
function matchLength(pathname: string, item: AdminNavItem): number | null {
  const prefixes = item.section?.length ? item.section : [item.href];
  let best: number | null = null;
  for (const prefix of prefixes) {
    if (!inSection(pathname, prefix)) continue;
    if (best === null || prefix.length > best) best = prefix.length;
  }
  return best;
}

/**
 * Longest match wins, so `/admin/users/abc` highlights Users and not Overview —
 * every admin path is nested under `/admin`, which would otherwise always match.
 */
export function isAdminNavActive(pathname: string, item: AdminNavItem): boolean {
  const own = matchLength(pathname, item);
  if (own === null) return false;
  return !adminNavItems.some((other) => {
    if (other === item) return false;
    const len = matchLength(pathname, other);
    return len !== null && len > own;
  });
}

export function activeAdminNavItem(pathname: string): AdminNavItem | undefined {
  return adminNavItems.find((item) => isAdminNavActive(pathname, item));
}

const SEGMENT_LABELS: Record<string, string> = {
  admin: "Admin",
  operations: "Operations",
  users: "Users",
  workspaces: "Workspaces",
  plans: "Plans",
  subscriptions: "Subscriptions",
  payments: "Payments",
  refunds: "Refunds",
  invoices: "Invoices",
  credits: "Credits",
  cards: "Cards on file",
  coupons: "Coupons",
  "billing-analytics": "Billing Analytics",
  email: "Email",
  announcements: "Announcements",
  support: "Support",
  apps: "Applications",
  deployments: "Deployments",
  domains: "Domains & DNS",
  terminal: "Terminal",
  "audit-logs": "Audit Logs",
  errors: "Errors",
  uploads: "Uploads",
  security: "Security",
  "feature-flags": "Feature Flags",
  settings: "Settings",
  login: "Sign in",
};

export interface AdminCrumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumbs for the admin header. The last crumb has no href — it is the page
 * you are on, and a link to yourself is a dead control.
 */
export function adminCrumbs(pathname: string): AdminCrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: AdminCrumb[] = [];
  let href = "";
  for (const [i, segment] of segments.entries()) {
    href += `/${segment}`;
    const known = SEGMENT_LABELS[segment];
    // An id segment (`/admin/users/<uuid>`) has no label of its own; show a
    // shortened form so the trail still reads as a place rather than a hash.
    const label = known ?? (segment.length > 12 ? `${segment.slice(0, 8)}…` : segment);
    crumbs.push({ label, href: i === segments.length - 1 ? undefined : href });
  }
  return crumbs;
}
