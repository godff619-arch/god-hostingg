// The admin panel's own front door.
//
// Why a second sign-in page at all, when the credentials are the same ones the
// app uses? Because the *destination* is different, and that is what an operator
// gets wrong. Signing in at `/sign-in` lands on `/projects`, so an operator who
// bookmarked the panel and lost their session used to be dropped into the tenant
// dashboard with no hint of where the panel went. This page keeps the intent:
// sign in here, land in `/admin`.
//
// It also refuses honestly. A password that is correct for an account with no
// admin role is still not a way in, and saying so beats a silent bounce back to
// the dashboard — which is what the shared gate would have done.
//
// The session itself is the same JWT (`docklift_token`). This is one identity
// system with a role on it, not two; a second credential store would mean a
// second password to lose and a second way to be locked out of your own server.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { APP_NAME } from "@/lib/brand";
import { hasAdminAccess, roleLabel } from "@/lib/roles";
import { API_URL } from "@/lib/utils";
import { invalidateAdminMe } from "@/hooks/useAdminMe";

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { user, login, logout, isAuthenticated } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Already signed in as an operator? Then this page is a redundant checkpoint —
  // go straight through. Done in an effect rather than a render-time <Navigate>
  // so a fresh sign-in below can navigate itself without racing this.
  useEffect(() => {
    if (isAuthenticated && hasAdminAccess(user?.role)) {
      navigate("/admin", { replace: true });
    }
  }, [isAuthenticated, user?.role, navigate]);

  const signedInWithoutAccess = isAuthenticated && !hasAdminAccess(user?.role);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign in failed");

      if (!hasAdminAccess(data.user?.role)) {
        // Correct password, wrong account. The session is not stored: an operator
        // who typed their customer account by mistake should be able to try again
        // without first working out how to sign out.
        throw new Error(
          "That account has no admin access. Sign in with an operator account, or use the customer app.",
        );
      }

      // A previous operator's permissions may still be cached in this tab.
      invalidateAdminMe();
      login(data.token, data.user);
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-brand-foreground">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </span>
          <h1 className="mt-3 text-[20px] font-semibold tracking-tight text-foreground">
            {APP_NAME} admin
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Platform operations. Not the customer dashboard.
          </p>
        </div>

        <Card className="p-6">
          {signedInWithoutAccess ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary p-3">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <div className="min-w-0 text-[13px]">
                  <p className="font-medium text-foreground">This account is not an operator</p>
                  <p className="mt-0.5 text-muted-foreground">
                    You are signed in as{" "}
                    <span className="font-medium text-foreground">{user?.email}</span> (
                    {roleLabel(user?.role)}), which has no access to the admin panel.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                className="press w-full"
                onClick={() => navigate("/projects")}
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" strokeWidth={1.75} />
                Go to the app
              </Button>
              <Button variant="ghost" className="press w-full" onClick={logout}>
                Sign in as someone else
              </Button>
            </div>
          ) : (
            <>
              {error ? (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-surface p-3 text-[13px] text-danger"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0">{error}</span>
                </div>
              ) : null}

              <form onSubmit={submit} className="space-y-3.5">
                <div>
                  <label htmlFor="admin-email" className="mb-1.5 block text-[13px] font-medium">
                    Email
                  </label>
                  <Input
                    id="admin-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    className="h-10"
                  />
                </div>
                <div>
                  <label htmlFor="admin-password" className="mb-1.5 block text-[13px] font-medium">
                    Password
                  </label>
                  <Input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="h-10"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || !email || !password}
                  className="press h-10 w-full gap-2 font-medium"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <ShieldCheck className="h-4 w-4" strokeWidth={2} />
                  )}
                  Sign in to admin
                </Button>
              </form>

              <p className="mt-5 text-center text-[12px] text-muted-foreground">
                Looking for your projects?{" "}
                <Link to="/sign-in" className="font-medium text-brand hover:text-brand-strong">
                  Customer sign in
                </Link>
              </p>
            </>
          )}
        </Card>

        {/* Every attempt is recorded server-side; saying so is a deterrent and a
            promise the audit log actually keeps (spec §24). */}
        <p className="mt-4 text-center text-[11px] text-subtle">
          Admin sign-ins are recorded in the audit log with the source IP address.
        </p>
      </div>
    </div>
  );
}
