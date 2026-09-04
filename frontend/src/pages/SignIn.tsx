// Login page

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Loader2, AlertCircle, LogIn } from "lucide-react";
import { API_URL } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuth } from "@/components/AuthProvider";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/auth/status`)
      .then((r) => r.json())
      .then((d) => setRegistrationEnabled(d.registrationEnabled !== false))
      .catch(() => setRegistrationEnabled(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }

      // Use AuthProvider's login function to update state and redirect
      login(data.token, data.user);
      
      // Redirect to dashboard
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <div className="absolute inset-0 rounded-2xl bg-brand/20 blur-xl" />
            <BrandLogo className="relative h-16 w-16 rounded-2xl shadow-[0_4px_14px_0_rgba(15,23,42,0.10)]" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {APP_NAME}
          </h1>
        </div>

        <Card className="p-8 border-border bg-card shadow-[0_2px_10px_0_rgba(15,23,42,0.06)]">
          <div className="mb-6">
            <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Sign in to access your dashboard.
            </p>
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Email</label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="admin@example.com"
                required
                className="h-11"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="••••••••"
                  required
                  className="h-11 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading || !formData.email || !formData.password}
              className="w-full h-11 gap-2 font-semibold"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              Sign In
            </Button>
          </form>

          {registrationEnabled && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <Link to="/sign-up" className="font-semibold text-brand hover:text-brand-strong">
                Create one
              </Link>
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
