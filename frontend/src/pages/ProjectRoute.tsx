// `/projects/:projectId` is shared by two eras of URL:
//
//   • `prj-…`  → a project group → render the canonical Project Overview
//   • a UUID   → an old single-resource bookmark → redirect to that resource's
//                canonical nested URL, preserving any `?tab=` the link carried
//
// Doing the split here (rather than with a second URL space) is what lets existing
// bookmarks and API links keep working while every new link is hierarchical.

import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import ProjectOverview from "@/pages/ProjectOverview";
import { isProjectGroupId, projectPath, projectSettingsPath, servicePath } from "@/lib/hierarchy";
import { authFetch } from "@/lib/auth";
import { API_URL } from "@/lib/utils";

interface ResourcePlacement {
  workspace_project_id: string | null;
  environment_id: string | null;
}

export default function ProjectRoute() {
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  const [placement, setPlacement] = useState<ResourcePlacement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isGroup = isProjectGroupId(projectId);

  useEffect(() => {
    if (!projectId || isGroup) return;
    let cancelled = false;
    // Legacy resource id: ask the resource where it lives, then redirect there.
    authFetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "not-found" : `HTTP ${res.status}`);
        return (await res.json()) as ResourcePlacement;
      })
      .then((data) => {
        if (!cancelled) setPlacement(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error && err.message === "not-found"
            ? "That service no longer exists."
            : "Could not open that link.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, isGroup]);

  if (!projectId) return <Navigate to="/projects" replace />;

  // The common case: a real project group.
  if (isGroup) return <ProjectOverview />;

  if (error) {
    return (
      <div className="mx-auto w-full max-w-[560px] py-16 text-center">
        <AlertTriangle className="mx-auto h-5 w-5 text-warning" strokeWidth={1.75} />
        <p className="mt-3 text-[13px] text-foreground">{error}</p>
        <a
          href="/projects"
          className="mt-4 inline-flex h-8 items-center rounded-md border border-border px-3 text-[12px] text-foreground transition-colors hover:bg-secondary"
        >
          Back to Projects
        </a>
      </div>
    );
  }

  if (!placement) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-3">
        <div className="h-8 w-56 animate-pulse rounded-md bg-secondary/60" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-secondary/40" />
      </div>
    );
  }

  const search = searchParams.toString();
  const target =
    servicePath(placement.workspace_project_id, placement.environment_id, projectId) +
    (search ? `?${search}` : "");
  return <Navigate to={target} replace />;
}

/** Old `/project/:projectId` → `/projects/:projectId`. */
export function LegacyProjectRedirect() {
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  if (!projectId) return <Navigate to="/projects" replace />;
  const search = searchParams.toString();
  return <Navigate to={projectPath(projectId) + (search ? `?${search}` : "")} replace />;
}

/** Old `/project/:projectId/settings` → `/projects/:projectId/settings`. */
export function LegacyProjectSettingsRedirect() {
  const { projectId } = useParams();
  if (!projectId) return <Navigate to="/projects" replace />;
  return <Navigate to={projectSettingsPath(projectId)} replace />;
}
