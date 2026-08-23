// Client-side admin gate. Cosmetic only — every /api/admin endpoint is enforced
// server-side (requireAdminAccess + requireAdminWrite). Any admin tier including
// the read-only `viewer` may enter; plain users are bounced to the dashboard.
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/components/AuthProvider";
import { hasAdminAccess } from "@/lib/roles";

export function AdminGuard() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!hasAdminAccess(user?.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}

export default AdminGuard;
