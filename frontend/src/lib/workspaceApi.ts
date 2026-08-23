// Client for the workspace/billing/integrations APIs.
//
// These routers answer with `{ success: false, error: { code, message } }`, so the
// thrown error keeps the machine-readable code. `PLAN_LOCKED` additionally carries
// the required tier, which is what <PlanGate/> renders — the UI never hardcodes
// which plan unlocks what.

import { authFetch } from "@/lib/auth";
import { API_URL } from "@/lib/utils";
import type { PlanTier } from "@/lib/workspaceTypes";

export class ApiError extends Error {
  code: string;
  status: number;
  requiredPlan?: PlanTier;
  currentPlan?: PlanTier;

  constructor(
    message: string,
    code: string,
    status: number,
    extra?: { requiredPlan?: PlanTier; currentPlan?: PlanTier },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requiredPlan = extra?.requiredPlan;
    this.currentPlan = extra?.currentPlan;
  }
}

/** True when the failure was a plan restriction rather than a real error. */
export function isPlanLocked(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "PLAN_LOCKED";
}

async function toError(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as
    | {
        error?: string | { code?: string; message?: string; required_plan?: PlanTier; current_plan?: PlanTier };
      }
    | null;

  const raw = data?.error;
  if (raw && typeof raw === "object") {
    return new ApiError(raw.message || `HTTP ${res.status}`, raw.code || "UNKNOWN", res.status, {
      requiredPlan: raw.required_plan,
      currentPlan: raw.current_plan,
    });
  }
  if (typeof raw === "string") return new ApiError(raw, "UNKNOWN", res.status);
  return new ApiError(`HTTP ${res.status}`, "UNKNOWN", res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, init);
  if (!res.ok) throw await toError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

/** GET a workspace-layer endpoint (path starts with `/api/...`). */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

/** POST/PATCH/PUT/DELETE a workspace-layer endpoint. */
export function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Human message for any thrown value, for toasts and error panels. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Save a file from an authenticated endpoint (CSV export, invoice PDF). The JWT
 * lives in a header, so a plain `<a download>` cannot fetch these — the body is
 * read as a blob and handed to a temporary object URL instead.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const res = await authFetch(`${API_URL}${path}`);
  if (!res.ok) throw await toError(res);

  // Prefer the server's filename; the header is the source of truth for period.
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const WORKSPACE_KEY = "docklift_workspace";

/** Workspace picked in the header switcher. NULL = the account's own workspace. */
export function activeWorkspaceId(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY) || null;
  } catch {
    return null; // Private mode / storage disabled — fall back to the default.
  }
}

export function setActiveWorkspaceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* Non-fatal: the request simply targets the default workspace. */
  }
}

/**
 * Scope a workspace-layer path to the selected workspace. The server still
 * verifies membership and 404s for a workspace the caller cannot open, so a
 * stale id in localStorage can only ever fail closed.
 */
export function scoped(path: string): string {
  const id = activeWorkspaceId();
  if (!id) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(id)}`;
}
