// The resource hierarchy the whole app navigates through:
//
//   Workspace → Project → Environment → Service → Deployment
//
// One module owns the URL shapes and the id-shape disambiguation so no page has
// to hand-build a nested path (or guess whether an id is a project or a service).

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiGet, scoped } from "@/lib/workspaceApi";

/** A project group id (`prj-xxxxxxxxxxxx`) as minted by the backend. */
export const PROJECT_ID_PREFIX = "prj-";

/**
 * True for a Render-style project group id.
 *
 * `/projects/:id` is deliberately shared between the new project route and the
 * old single-resource bookmarks, and the two id shapes are distinguishable:
 * groups are `prj-…`, deployable resources are UUIDs. That is what lets old
 * links keep working without a second URL space.
 */
export function isProjectGroupId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(PROJECT_ID_PREFIX);
}

/** `/projects` — the project cards. */
export const projectsPath = "/projects";

/** `/projects/:projectId` — project overview. */
export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

/** `/projects/:projectId/settings` — project settings (never service settings). */
export function projectSettingsPath(projectId: string): string {
  return `${projectPath(projectId)}/settings`;
}

/** `/projects/:projectId/environments/:environmentId`. */
export function environmentPath(projectId: string, environmentId: string): string {
  return `${projectPath(projectId)}/environments/${encodeURIComponent(environmentId)}`;
}

/**
 * `/projects/:projectId/environments/:environmentId/services/:serviceId` — the
 * canonical service URL. Falls back to the flat `/projects/:serviceId` form when
 * the resource has not been placed in the hierarchy yet, which stays a valid
 * (redirecting) route.
 */
export function servicePath(
  projectId: string | null | undefined,
  environmentId: string | null | undefined,
  serviceId: string,
): string {
  if (!projectId || !environmentId) return `/projects/${encodeURIComponent(serviceId)}`;
  return `${environmentPath(projectId, environmentId)}/services/${encodeURIComponent(serviceId)}`;
}

/** Query string that pre-selects (and locks) the deploy target. */
export function deployQuery(
  projectId: string | null | undefined,
  environmentId?: string | null,
): string {
  if (!projectId) return "";
  const params = new URLSearchParams({ project: projectId });
  if (environmentId) params.set("environment", environmentId);
  return `?${params.toString()}`;
}

export interface EnvironmentNavItem {
  id: string;
  name: string;
  is_default: boolean;
}

export interface HierarchyContext {
  /** The project group in the URL, or null outside the hierarchy. */
  projectId: string | null;
  /** The environment in the URL, or null on the bare project route. */
  environmentId: string | null;
  /** The service in the URL, or null above that level. */
  serviceId: string | null;
}

/**
 * Where the current URL sits in the hierarchy. Parsed rather than read from
 * `useParams` so shell chrome (top bar, sidebar) — which is mounted outside the
 * matched route — can ask the same question a page can.
 */
export function parseHierarchyPath(pathname: string): HierarchyContext {
  const segments = pathname.split("/").filter(Boolean);
  const none: HierarchyContext = { projectId: null, environmentId: null, serviceId: null };
  if (segments[0] !== "projects" || !isProjectGroupId(segments[1])) return none;
  return {
    projectId: segments[1],
    environmentId: segments[2] === "environments" ? segments[3] ?? null : null,
    serviceId: segments[4] === "services" ? segments[5] ?? null : null,
  };
}

/** `parseHierarchyPath` for the URL being rendered. */
export function useHierarchyContext(): HierarchyContext {
  const { pathname } = useLocation();
  return useMemo(() => parseHierarchyPath(pathname), [pathname]);
}

interface ProjectNavPayload {
  project: { id: string; name: string };
  environments: EnvironmentNavItem[];
}

/**
 * Environment list for a project, for navigation chrome (sidebar rail,
 * breadcrumbs, deploy-target pickers). Uses the cheap nav endpoint — no resource
 * rows — so it is safe to call from a persistently mounted component.
 */
export function useProjectNav(projectId: string | null): {
  name: string | null;
  environments: EnvironmentNavItem[];
  loading: boolean;
} {
  const [payload, setPayload] = useState<ProjectNavPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId || !isProjectGroupId(projectId)) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<ProjectNavPayload>(scoped(`/api/workspace/projects/${encodeURIComponent(projectId)}/environments`))
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch(() => {
        // Navigation chrome degrades to "no environments" rather than erroring;
        // the page itself surfaces the real failure with a Retry.
        if (!cancelled) setPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return {
    name: payload?.project.name ?? null,
    environments: payload?.environments ?? [],
    loading,
  };
}
