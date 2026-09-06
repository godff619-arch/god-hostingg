// Who is signed in to the admin panel, and what may they do?
//
// The permission list is *derived on the server* from the live DB role
// (`GET /api/admin/me` → `permissionsFor(role)`), never computed here. That is the
// point: there is one permission matrix in the system, so a rail item cannot claim
// a capability the API would refuse — and a role revoked in the database takes
// effect on the next page load rather than whenever a bundle happens to reload.
//
// Hiding a control is cosmetic. Every `/api/admin/*` route runs
// `adminPermissionGate` before its handler, so this hook only decides what is
// worth *offering*; it is not a security boundary.

import { useCallback, useEffect, useState } from "react";
import { adminGet } from "@/lib/adminApi";

/** Mirrors `PERMISSIONS` in `backend/src/lib/adminPermissions.ts`. */
export type AdminPermission = string;

/**
 * The two platform switches, delivered with `/me` because the shell needs them on
 * every page and every admin tier is allowed to read them. `GET /settings` would
 * be the obvious source and is the wrong one — a `billing_admin` is refused it.
 */
export interface AdminPlatformState {
  maintenance_mode: boolean;
  maintenance_message: string;
  deployments_enabled: boolean;
}

export interface AdminMe {
  id: string | null;
  email: string | null;
  name: string | null;
  role: string;
  role_label: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  permissions: AdminPermission[];
  platform?: AdminPlatformState;
}

export interface AdminMeState {
  me: AdminMe | null;
  loading: boolean;
  /** Set when `/me` itself failed — a revoked session, or the API being down. */
  error: string | null;
  /** True once the server has answered; gates "you have no access" screens. */
  ready: boolean;
  /** Server-derived. Unknown permissions are refused, never assumed. */
  can: (permission: AdminPermission) => boolean;
  reload: () => void;
}

// One request per page load, shared by the shell, the rail and every page that
// gates a button on a permission. Without this, a page with four permission
// checks made four identical round trips before it could render.
let cached: AdminMe | null = null;
let inFlight: Promise<AdminMe> | null = null;
const subscribers = new Set<(me: AdminMe | null) => void>();

function load(): Promise<AdminMe> {
  inFlight ??= adminGet<AdminMe>("/me").then((me) => {
    cached = me;
    subscribers.forEach((notify) => notify(me));
    return me;
  });
  return inFlight;
}

/** Drop the cache — call after a role change so the rail reflects it at once. */
export function invalidateAdminMe(): void {
  cached = null;
  inFlight = null;
}

export function useAdminMe(): AdminMeState {
  const [me, setMe] = useState<AdminMe | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(Boolean(cached));

  const run = useCallback((notify: (me: AdminMe | null) => void) => {
    setLoading(true);
    load().then(
      (result) => {
        notify(result);
        setError(null);
        setLoading(false);
        setReady(true);
      },
      (err: unknown) => {
        // A failed `/me` must not read as "no permissions" — that would render a
        // fully-featured panel as an empty one. `ready` stays true so the caller
        // can show the error instead of a spinner that never resolves.
        inFlight = null;
        setError(err instanceof Error ? err.message : "Could not load your admin profile");
        setLoading(false);
        setReady(true);
      },
    );
  }, []);

  useEffect(() => {
    let alive = true;
    const notify = (next: AdminMe | null) => {
      if (alive) setMe(next);
    };
    subscribers.add(notify);
    if (cached) {
      setMe(cached);
      setReady(true);
      setLoading(false);
    } else {
      run(notify);
    }
    return () => {
      alive = false;
      subscribers.delete(notify);
    };
  }, [run]);

  const reload = useCallback(() => {
    invalidateAdminMe();
    setReady(false);
    run((next) => setMe(next));
  }, [run]);

  const can = useCallback(
    (permission: AdminPermission) => Boolean(me?.permissions?.includes(permission)),
    [me],
  );

  return { me, loading, error, ready, can, reload };
}
