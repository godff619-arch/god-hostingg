// Client-side admin gate. Cosmetic only — every /api/admin endpoint is enforced
// server-side (requireAdminAccess + requireAdminWrite). Any admin tier including
// the read-only `viewer` may enter; plain users are bounced to the dashboard.
//
// `write` narrows the gate to full admins (owner/super_admin/admin) for areas a
// viewer must not reach at all — the server terminal, whose shell is root in the
// panel container. Enforced in routes/auth.ts (requireAdmin) and re-checked
// against the live role in services/terminal.ts.
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/components/AuthProvider";
import { hasAdminAccess, isFullAdmin } from "@/lib/roles";

export function AdminGuard({ write = false }: { write?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  const allowed = write ? isFullAdmin(user?.role) : hasAdminAccess(user?.role);
  // `/projects`, not `/` — `/` is the public homepage, so bouncing a signed-in
  // user there would look like being logged out.
  if (!allowed) return <Navigate to="/projects" replace />;
  return <Outlet />;
}

export default AdminGuard;
