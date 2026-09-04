import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppProviders } from "./AppProviders";
import { AppShell } from "./AppShell";
import { ProtectedLayout } from "./ProtectedLayout";
import { AdminGuard } from "./AdminGuard";

function Root() {
  return (
    <AppProviders>
      <ProtectedLayout />
    </AppProviders>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
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
            // Landing page redirects into the canonical Projects list so there is
            // exactly one project-cards page (no duplicate implementations).
            index: true,
            element: <Navigate to="/projects" replace />,
          },
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
            path: "system",
            lazy: async () => {
              const m = await import("@/pages/System");
              return { Component: m.default };
            },
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
          {
            path: "admin",
            element: <AdminGuard />,
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
                path: "audit-logs",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminAuditLogs");
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
                path: "uploads",
                lazy: async () => {
                  const m = await import("@/pages/admin/AdminUploads");
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
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
