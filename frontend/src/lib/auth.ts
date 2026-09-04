// Utility hook for making authenticated API calls

import { API_URL } from "@/lib/utils";

let unauthorizedHandler: (() => void) | null = null;
let maintenanceHandler: ((message: string) => void) | null = null;

/** Called once from AuthProvider so 401 responses clear session app-wide. */
export function registerAuthUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

/**
 * Called once from the shell so a 503 `{maintenance: true}` from anywhere in the
 * app raises the maintenance page, instead of each caller surfacing its own
 * unexplained "HTTP 503" toast.
 */
export function registerMaintenanceHandler(handler: (message: string) => void): void {
  maintenanceHandler = handler;
}

function handleUnauthorized(response: Response): void {
  if (response.status === 401 && unauthorizedHandler) {
    unauthorizedHandler();
  }
}

/**
 * Sniff an operator maintenance window out of a 503. The body is read from a
 * clone so the original response stays intact for whoever asked for it, and only
 * for 503s — every other status skips this entirely.
 */
function handleMaintenance(response: Response): void {
  if (response.status !== 503 || !maintenanceHandler) return;
  void response
    .clone()
    .json()
    .then((body: unknown) => {
      const data = body as { maintenance?: boolean; error?: string } | null;
      if (data?.maintenance) maintenanceHandler?.(data.error || "");
    })
    .catch(() => {
      /* a 503 without a JSON body is a proxy/gateway error, not our gate */
    });
}

// Get auth headers for API calls
export function getAuthHeaders(): HeadersInit {
  if (typeof window === "undefined") return {};
  
  const token = localStorage.getItem("docklift_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Start GitHub App install: sets HttpOnly nonce cookie, returns GitHub URL to open/navigate. */
export async function startGithubInstallSession(returnUrl?: string): Promise<string> {
  const res = await authFetch(`${API_URL}/api/github/install-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ returnUrl: returnUrl || window.location.href }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.installUrl) {
    throw new Error(data.error || "Failed to start GitHub install");
  }
  return data.installUrl as string;
}

/**
 * Start install session then open GitHub.
 * Opens a blank tab synchronously (before await) so popup blockers do not kill it.
 * Pass `{ sameTab: true }` to navigate the current tab instead.
 */
export async function startGithubInstallAndNavigate(
  returnUrl?: string,
  opts?: { sameTab?: boolean }
): Promise<void> {
  const sameTab = opts?.sameTab === true;
  const popup = sameTab ? null : window.open("about:blank", "_blank");
  try {
    const installUrl = await startGithubInstallSession(returnUrl);
    if (popup && !popup.closed) {
      try {
        popup.opener = null;
      } catch {
        /* ignore */
      }
      popup.location.href = installUrl;
      return;
    }
    window.location.href = installUrl;
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    throw error;
  }
}

// Authenticated fetch wrapper
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });
  handleUnauthorized(response);
  handleMaintenance(response);
  return response;
}

// Typed fetch that handles auth and returns JSON
export async function fetchWithAuth<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;
  
  const response = await authFetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Session expired");
    }
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
