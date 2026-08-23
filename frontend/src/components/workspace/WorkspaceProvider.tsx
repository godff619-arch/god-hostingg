// Workspace context — one fetch of `GET /api/workspace` for the whole shell.
//
// The header avatar/selector, the plan badge, the Upgrade button and every
// <PlanGate/> read from here, so no component invents a plan, a workspace id or a
// feature flag of its own.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  apiGet,
  apiSend,
  errorMessage,
  scoped,
  setActiveWorkspaceId,
} from "@/lib/workspaceApi";
import type {
  FeatureKey,
  WorkspaceContextPayload,
  WorkspaceListItem,
  WorkspaceSummary,
} from "@/lib/workspaceTypes";

interface WorkspaceContextValue {
  workspace: WorkspaceSummary | null;
  counts: { projects: number; resources: number; members: number } | null;
  owner: { name: string; email: string } | null;
  /** Every workspace the caller can open — the header switcher list. */
  workspaces: WorkspaceListItem[];
  loading: boolean;
  error: string | null;
  /** Re-read the workspace (after a rename, plan change or project create). */
  refresh: () => Promise<void>;
  /** Point the whole shell at another workspace the caller belongs to. */
  switchWorkspace: (id: string) => Promise<void>;
  /** Create a workspace owned by the caller and switch to it. */
  createWorkspace: (name: string) => Promise<WorkspaceListItem>;
  /** Server-resolved capability check. Unknown workspace ⇒ locked. */
  can: (feature: FeatureKey) => boolean;
  /** Viewers get read-only UI; the server enforces the same rule. */
  canWrite: boolean;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<WorkspaceContextPayload | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [context, list] = await Promise.all([
        apiGet<WorkspaceContextPayload>(scoped("/api/workspace")),
        apiGet<{ workspaces: WorkspaceListItem[] }>("/api/workspace/list"),
      ]);
      setPayload(context);
      setWorkspaces(list.workspaces);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchWorkspace = useCallback(
    async (id: string) => {
      setActiveWorkspaceId(id);
      setLoading(true);
      await refresh();
    },
    [refresh],
  );

  const createWorkspace = useCallback(
    async (name: string) => {
      const data = await apiSend<{ workspace: WorkspaceListItem }>(
        "/api/workspace",
        "POST",
        { name },
      );
      await switchWorkspace(data.workspace.id);
      return data.workspace;
    },
    [switchWorkspace],
  );

  const value = useMemo<WorkspaceContextValue>(() => {
    const workspace = payload?.workspace ?? null;
    return {
      workspace,
      counts: payload?.counts ?? null,
      owner: payload?.owner ?? null,
      workspaces,
      loading,
      error,
      refresh,
      switchWorkspace,
      createWorkspace,
      can: (feature) => Boolean(workspace?.features?.[feature]),
      canWrite: workspace ? workspace.role !== "viewer" : false,
    };
  }, [payload, workspaces, loading, error, refresh, switchWorkspace, createWorkspace]);

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
