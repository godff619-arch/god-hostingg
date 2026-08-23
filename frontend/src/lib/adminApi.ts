// Typed admin API client. Wraps authFetch + API_URL for all `/api/admin` endpoints.

import { authFetch } from "@/lib/auth";
import { API_URL } from "@/lib/utils";

const ADMIN_BASE = `${API_URL}/api/admin`;

async function parseError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data && data.error) {
    return String((data as { error: unknown }).error);
  }
  return `HTTP ${res.status}`;
}

/** GET `${API_URL}/api/admin${path}`; throws on !res.ok. */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await authFetch(`${ADMIN_BASE}${path}`);
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as T;
}

/** Send a mutation (POST/PATCH/DELETE/PUT) to an admin endpoint; throws on !res.ok. */
export async function adminSend<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await authFetch(`${ADMIN_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  // DELETE handlers may return an empty body; tolerate that.
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

/**
 * Fetch an admin endpoint as a file and trigger a browser download. Auth stays in
 * the Authorization header (these export routes are Bearer-gated, no query token),
 * so we pull the response as a Blob and click a transient object URL rather than
 * navigating the window. The server sets Content-Disposition; `fallbackName` is
 * only used if the header is missing.
 */
export async function adminDownload(path: string, fallbackName: string): Promise<void> {
  const res = await authFetch(`${ADMIN_BASE}${path}`);
  if (!res.ok) throw new Error(await parseError(res));

  // Prefer the server-supplied filename (audit-logs-<date>.csv etc.).
  let filename = fallbackName;
  const cd = res.headers.get("content-disposition");
  const match = cd?.match(/filename="?([^"]+)"?/i);
  if (match?.[1]) filename = match[1];

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Call a non-admin endpoint directly (admin bypasses ownership server-side).
 * Used by AdminApps for deployment/project actions. Path is appended to API_URL.
 */
export async function apiSend<T = unknown>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}
