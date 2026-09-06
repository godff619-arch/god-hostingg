import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { AppProviders } from "./AppProviders";
import { AppShell } from "./AppShell";
import { AdminShell } from "./AdminShell";
import { ProtectedLayout } from "./ProtectedLayout";
import { AdminGuard } from "./AdminGuard";
import { useAuth } from "@/components/AuthProvider";

function Root() {
  return (
    <AppProviders>
      <ProtectedLayout />
    </AppProviders>
  );
}

/**
 * Unknown URL. A session wants its dashboard back; a visitor without one wants
 * the front door — sending both to `/` would drop a signed-in user onto the
 * marketing page and make it look like they had been logged out.
 */
function NotFoundRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? "/projects" : "/"} replace />;
}

/**
 * `/terminal` moved into the admin panel. The query string comes along: the rail's
 * upgrade button links to `?confirm=upgrade`, and dropping it would land on a bare
 * shell with the confirmation step silently skipped.
 */
function TerminalRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: "/admin/terminal", search, hash }} replace />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      {
        // The public front door (pages/Landing.tsx). Outside <AppShell /> on
        // purpose: a guest has no session, no workspace and no rail to hang the
        // page on. The signed-in dashboard is `/projects`.
        index: true,
        lazy: async () => {
          const m = await import("@/pages/Landing");
          return { Component: m.default };
        },
      },
      // Sign-in and setup render without the shell — there is no session yet.
      {
        path: "sign-in",
        lazy: async () => {
          const m = await import("@/pages/SignIn");
          return { Component: m.default };
        },
      },
      {
        path: "sign-up",
        lazy: async () => {
          const m = await import("@/pages/SignUp");
          return { Component: m.default };
        },
      },
      {
        path: "setup",
        lazy: async () => {
          const m = await import("@/pages/Setup");
          return { Component: m.default };
        },
      },
      {
        element: <AppShell />,
        children: [
          {
            // PROJECTS — the project cards. Never a flat service list.
            path: "projects",
            lazy: async () => {
              const m = await import("@/pages/Projects");
              return { Component: m.default };
            },
          },
          {
            // Static segment outranks `:projectId`, so this stays reachable.
            path: "projects/new",
            lazy: async () => {
              const m = await import("@/pages/NewProject");
              return { Component: m.default };
            },
          },
          {
            // PROJECT — overview for `prj-…` ids. UUIDs here are legacy resource
            // bookmarks and get redirected to their canonical nested URL.
            path: "projects/:projectId",
            lazy: async () => {
              const m = await import("@/pages/ProjectRoute");
              return { Component: m.default };
            },
          },
          {
            path: "projects/:projectId/settings",
            lazy: async () => {
              const m = await import("@/pages/ProjectSettings");
              return { Component: m.default };
            },
          },
          {
            // ENVIRONMENT — the project overview focused on one environment.
            path: "projects/:projectId/environments/:environmentId",
            lazy: async () => {
              const m = await import("@/pages/ProjectOverview");
              return { Component: m.default };
            },
          },
          {
            // SERVICE — deployments / logs / settings live in tabs on this page.
            path: "projects/:projectId/environments/:environmentId/services/:serviceId",
            lazy: async () => {
              const m = await import("@/pages/ProjectDetail");
              return { Component: m.default };
            },
          },
          {
            // Old singular `/project/:id` links (and their settings page) keep
            // working by redirecting onto the plural canonical routes.
            path: "project/:projectId",
            lazy: async () => {
              const m = await import("@/pages/ProjectRoute");
              return { Component: m.LegacyProjectRedirect };
            },
          },
          {
            path: "project/:projectId/settings",
            lazy: async () => {
              const m = await import("@/pages/ProjectRoute");
              return { Component: m.LegacyProjectSettingsRedirect };
            },
          },
          {
            // Part C: `/billing` uses the selected workspace; the explicit
            // `/workspace/:workspaceId/billing` form targets one by id.
            path: "billing",
            lazy: async () => {
              const m = await import("@/pages/Billing");
              return { Component: m.default };
            },
          },
          {
            path: "workspace/:workspaceId/billing",
            lazy: async () => {
              const m = await import("@/pages/Billing");
              return { Component: m.default };
            },
          },
          {
            // Workspace Settings (Part C §41–§53). `/settings` stays the account
            // page, so the workspace form lives under `/workspace/...`.
            path: "workspace/settings",
            lazy: async () => {
              const m = await import("@/pages/WorkspaceSettings");
              return { Component: m.default };
            },
          },
          {
            path: "workspace/:workspaceId/settings",
            lazy: async () => {
              const m = await import("@/pages/WorkspaceSettings");
              return { Component: m.default };
            },
          },
          {
            // Part C integrations / networking.
            path: "webhooks",
            lazy: async () => {
              const m = await import("@/pages/Webhooks");
              return { Component: m.default };
            },
          },
          {
            path: "observability",
            lazy: async () => {
              const m = await import("@/pages/Observability");
              return { Component: m.default };
            },
          },
          {
            // Delivery preferences, outbound channels and the caller's own feed.
            path: "notifications",
            lazy: async () => {
              const m = await import("@/pages/Notifications");
              return { Component: m.default };
            },
          },
          {
            // The customer's half of the admin Support inbox (§23). The operator
            // side is `/admin/support`; this is where the ticket is opened.
            path: "support",
            lazy: async () => {
              const m = await import("@/pages/Support");
              return { Component: m.default };
            },
          },
          {
            // Service-to-service internal networking (Part A → NETWORKING).
            path: "private-links",
            lazy: async () => {
              const m = await import("@/pages/PrivateLinks");
              return { Component: m.default };
            },
          },
          {
            path: "dedicated-ips",
            lazy: async () => {
              const m = await import("@/pages/DedicatedIps");
              return { Component: m.default };
            },
          },
          {
            // Infrastructure-as-code for the workspace (Part A sidebar entry).
            path: "blueprints",
            lazy: async () => {
              const m = await import("@/pages/Blueprints");
              return { Component: m.default };
            },
          },
          {
            // Part A sidebar entry; also the source of the project overview's
            // `Env Groups (X)` tab count.
            path: "environment-groups",
            lazy: async () => {
              const m = await import("@/pages/EnvironmentGroups");
              return { Component: m.default };
            },
          },
          {
            path: "logs",
            lazy: async () => {
              const m = await import("@/pages/Logs");
              return { Component: m.default };
            },
          },
          {
            // The old tenant-shell terminal URL. The page moved into the admin
            // panel (it is a root shell on the host, not a workspace feature);
            // the redirect keeps existing bookmarks and links working.
            path: "terminal",
            element: <TerminalRedirect />,
          },
          {
            // Availability for everyone. `/system` below is the operator's view of
            // the same host and stays gated.
            path: "status",
            lazy: async () => {
              const m = await import("@/pages/Status");
              return { Component: m.default };
            },
          },
          {
            // Host metrics, disks, kernel, load, PIDs. Admin-only: the API refuses
            // a non-admin (routes/system.ts), and this stops the URL being typed
            // in for a page that would then only render errors.
            path: "system",
            element: <AdminGuard />,
            children: [
              {
                index: true,
                lazy: async () => {
                  const m = await import("@/pages/System");
                  return { Component: m.default };
                },
              },
            ],
          },
          {
            path: "ports",
            lazy: async () => {
              const m = await import("@/pages/Ports");
              return { Component: m.default };
            },
          },
          {
            path: "databases",
            lazy: async () => {
              const m = await import("@/pages/Databases");
              return { Component: m.default };
            },
          },
          {
            path: "databases/new",
            lazy: async () => {
              const m = await import("@/pages/NewDatabase");
              return { Component: m.default };
            },
          },
          {
            path: "settings",
            lazy: async () => {
              const m = await import("@/pages/Settings");
              return { Component: m.default };
            },
          },
          {
            path: "docs",
            lazy: async () => {
              const m = await import("@/pages/Docs");
              return { Component: m.default };
            },
          },
        ],
      },
      {
        // THE ADMIN PANEL — a sibling of <AppShell />, not a page inside it.
        //
        // Its own rail, its own header, no workspace context and no maintenance
        // gate. Nesting it in the tenant shell is what produced the old layout
        // where a customer's Projects link sat one row above a destructive
        // platform switch, and where an operator working during maintenance was
        // shown the maintenance page by their own shell.
        path: "admin/login",
        lazy: async () => {
          const m = await import("@/pages/admin/AdminLogin");
          return { Component: m.default };
        },
      },
      {
        path: "admin",
        element: <AdminGuard />,
        children: [
          {
            element: <AdminShell />,
            children: [
              {
                index: true,
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminOverview");
                  return { Component: m.default };
                },
              },
              {
                path: "operations",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminOperations");
                  return { Component: m.default };
                },
              },
              {
                path: "users",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminUsers");
                  return { Component: m.default };
                },
              },
              {
                path: "users/:id",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminUserDetail");
                  return { Component: m.default };
                },
              },
              {
                path: "workspaces",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminWorkspaces");
                  return { Component: m.default };
                },
              },
              {
                path: "workspaces/:id",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminWorkspaceDetail");
                  return { Component: m.default };
                },
              },
              {
                path: "apps",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminApps");
                  return { Component: m.default };
                },
              },
              {
                path: "deployments",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminDeployments");
                  return { Component: m.default };
                },
              },
              {
                path: "domains",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminDomains");
                  return { Component: m.default };
                },
              },
              {
                // The host shell. Full admins only — a read-only viewer must not
                // reach a root prompt (re-checked in services/terminal.ts).
                path: "terminal",
                element: <AdminGuard write />,
                children: [
                  {
                    index: true,
                    lazy: async () => {
                      const m = await import("@/pages/Terminal");
                      return { Component: m.default };
                    },
                  },
                ],
              },
              {
                path: "audit-logs",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminAuditLogs");
                  return { Component: m.default };
                },
              },
              {
                path: "feature-flags",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminFeatureFlags");
                  return { Component: m.default };
                },
              },
              {
                path: "errors",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminErrors");
                  return { Component: m.default };
                },
              },
              {
                path: "plans",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminPlans");
                  return { Component: m.default };
                },
              },
              {
                path: "subscriptions",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminSubscriptions");
                  return { Component: m.default };
                },
              },
              {
                path: "payments",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminPayments");
                  return { Component: m.default };
                },
              },
              {
                path: "invoices",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminInvoices");
                  return { Component: m.default };
                },
              },
              {
                path: "credits",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminCredits");
                  return { Component: m.default };
                },
              },
              {
                path: "cards",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminCards");
                  return { Component: m.default };
                },
              },
              {
                path: "refunds",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminRefunds");
                  return { Component: m.default };
                },
              },
              {
                path: "coupons",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminCoupons");
                  return { Component: m.default };
                },
              },
              {
                path: "billing-analytics",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminBillingAnalytics");
                  return { Component: m.default };
                },
              },
              {
                path: "email",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminEmail");
                  return { Component: m.default };
                },
              },
              {
                path: "announcements",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminAnnouncements");
                  return { Component: m.default };
                },
              },
              {
                path: "support",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminSupport");
                  return { Component: m.default };
                },
              },
              {
                // The link every "new support ticket" notification carries. Same
                // page; the id opens that thread on arrival instead of dropping the
                // operator on an inbox and making them search for it.
                path: "support/:ticketId",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminSupport");
                  return { Component: m.default };
                },
              },
              {
                path: "uploads",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminUploads");
                  return { Component: m.default };
                },
              },
              {
                path: "security",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminSecurity");
                  return { Component: m.default };
                },
              },
              {
                path: "settings",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminSettings");
                  return { Component: m.default };
                },
              },
            ],
          },
        ],
      },
      { path: "*", element: <NotFoundRedirect /> },
    ],
  },
]);
