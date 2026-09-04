// Setup page - first-time registration for root admin

import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Container, Eye, EyeOff, Loader2, Check, AlertCircle, Upload, RotateCcw, FileUp, ArrowLeft } from "lucide-react";
import { API_URL } from "@/lib/utils";
import { consumeProgressStream } from "@/lib/streamProgress";

export default function SetupPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [mode, setMode] = useState<'register' | 'restore'>('register');
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    bootstrapSecret: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Only asked for when the operator set REQUIRE_BOOTSTRAP_SECRET. A one-click
  // host (Coolify / Render / plain `docker run`) usually has no console to copy a
  // secret from, so by default the first account here just wins and becomes OWNER.
  const [bootstrapRequired, setBootstrapRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/auth/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setBootstrapRequired(data.bootstrapRequired === true);
      })
      .catch(() => {
        // Leave the field hidden — the API still answers with the reason if it
        // does demand a secret, and that error is surfaced below.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore state
  const [restoreProgress, setRestoreProgress] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const validatePassword = (password: string) => {
    return password.length >= 8;
  };

  const isPasswordValid = validatePassword(formData.password);
  const passwordsMatch = formData.password === formData.confirmPassword && formData.confirmPassword.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!isPasswordValid) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (!passwordsMatch) {
      setError("Passwords do not match");
      return;
    }

    if (bootstrapRequired && !formData.bootstrapSecret.trim()) {
      setError("Bootstrap secret is required (from backend logs or data/.bootstrap-secret)");
      return;
    }

    setLoading(true);
    try {
      const secret = formData.bootstrapSecret.trim();
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "x-bootstrap-secret": secret } : {}),
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password,
          ...(secret ? { bootstrapSecret: secret } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Registration failed");
      }

      // Store token and user in global auth state
      auth.login(data.token, data.user);

      // Redirect to dashboard
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const processRestoreFile = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setError("Please select a .zip backup file");
      return;
    }

    setError("");
    setRestoring(true);
    setRestoreProgress([]);

    try {
      const secret = formData.bootstrapSecret.trim();
      if (bootstrapRequired && !secret) {
        setError("Bootstrap secret is required for restore (from backend logs or data/.bootstrap-secret)");
        setRestoring(false);
        return;
      }

      const upload = new FormData();
      upload.append('backup', file);

      // The setup token is only handed out pre-first-user, and is gated by the
      // bootstrap secret when one is required.
      let headers: HeadersInit = secret ? { 'x-bootstrap-secret': secret } : {};
      try {
        const tokenRes = await fetch(`${API_URL}/api/auth/setup-token`, {
          headers: secret ? { 'x-bootstrap-secret': secret } : {},
        });
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (tokenData.setupToken) {
            headers['x-setup-token'] = tokenData.setupToken;
          }
        } else {
          const errData = await tokenRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to authorize restore');
        }
      } catch (e: any) {
        setError(e.message || 'Failed to authorize restore');
        setRestoring(false);
        return;
      }

      const res = await fetch(`${API_URL}/api/backup/restore-upload`, {
        method: 'POST',
        headers,
        body: upload,
      });

      const result = await consumeProgressStream(res, (line) => {
        if (line.trim()) setRestoreProgress((prev) => [...prev, line]);
      });

      if (!result.ok) {
        setError(result.error || "Restore failed");
        return;
      }

      setRestoreComplete(true);
    } catch (err: any) {
      setError(err.message || "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processRestoreFile(file);
    e.target.value = '';
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      await processRestoreFile(file);
    }
  };

  // Show restore progress/complete view
  if (restoring || restoreComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-2xl">
          <Card className="p-8 border-warning-border bg-card shadow-[0_2px_10px_0_rgba(15,23,42,0.06)]">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 rounded-xl border border-warning-border bg-warning-surface">
                <RotateCcw className={`h-6 w-6 text-warning ${restoring ? 'animate-spin' : ''}`} />
              </div>
              <div>
                <h2 className="text-2xl font-bold">
                  {restoreComplete ? 'Restore Complete' : 'Restoring Backup...'}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {restoreComplete ? 'Your God Hosting instance has been restored' : 'Please wait while your backup is being restored'}
                </p>
              </div>
            </div>

            {/* Restore log — the one dark panel on this page, same navy plane as
                the shell canvas, because it is streamed console output. */}
            <div className="dark-scroll mb-6 max-h-[400px] overflow-y-auto rounded-lg border border-sidebar-border bg-sidebar p-4 font-mono text-xs text-sidebar-foreground/85">
              {restoreProgress.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap">{line}</div>
              ))}
              {restoring && <span className="animate-pulse text-success-border">▌</span>}
            </div>

            {restoreComplete && (
              <div className="space-y-4">
                <div className="rounded-lg border border-success-border bg-success-surface p-4">
                  <p className="font-semibold text-success">Restore successful!</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    You can now sign in with your existing credentials from the backup.
                  </p>
                </div>
                <Button
                  onClick={() => navigate('/sign-in')}
                  className="w-full h-11 font-semibold"
                >
                  Go to Sign In
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <div className="absolute inset-0 rounded-2xl bg-brand/20 blur-xl" />
            <div className="relative rounded-2xl bg-brand p-4 shadow-[0_4px_14px_0_rgba(15,23,42,0.10)]">
              <Container className="h-10 w-10 text-brand-foreground" strokeWidth={2.5} />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            God Hosting
          </h1>
        </div>

        {mode === 'register' ? (
          <Card className="p-8 border-border bg-card shadow-[0_2px_10px_0_rgba(15,23,42,0.06)]">
            <div className="mb-6">
              <h2 className="text-2xl font-bold tracking-tight">Create an account</h2>
              <p className="text-sm text-brand mt-1 font-medium">
                This user will be the root user (full admin access).
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
                <label className="text-sm font-medium mb-1.5 block">
                  Name <span className="text-danger">*</span>
                </label>
                <Input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Your name"
                  required
                  className="h-11"
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Email <span className="text-danger">*</span>
                </label>
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
                <label className="text-sm font-medium mb-1.5 block">
                  Password <span className="text-danger">*</span>
                </label>
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
                {formData.password.length > 0 && formData.password.length < 8 && (
                  <p className="text-xs text-muted-foreground mt-1">Password must be at least 8 characters</p>
                )}
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Confirm Password <span className="text-danger">*</span>
                </label>
                <div className="relative">
                  <Input
                    type={showConfirmPassword ? "text" : "password"}
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    placeholder="••••••••"
                    required
                    className="h-11 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {formData.confirmPassword && !passwordsMatch && (
                  <p className="text-xs text-danger mt-1">Passwords do not match</p>
                )}
              </div>

              {bootstrapRequired && (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Bootstrap secret <span className="text-danger">*</span>
                  </label>
                  <Input
                    type="password"
                    value={formData.bootstrapSecret}
                    onChange={(e) => setFormData({ ...formData, bootstrapSecret: e.target.value })}
                    placeholder="From docker logs / data/.bootstrap-secret"
                    required
                    autoComplete="off"
                    className="h-11 font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Shown once in backend logs on first start. Prevents remote claim of a fresh install.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                disabled={
                  loading ||
                  !isPasswordValid ||
                  !passwordsMatch ||
                  !formData.name ||
                  !formData.email ||
                  (bootstrapRequired && !formData.bootstrapSecret.trim())
                }
                className="w-full h-11 font-semibold"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Register
              </Button>
            </form>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border"></div>
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or</span>
              </div>
            </div>

            <Button
              type="button"
              variant="warning"
              onClick={() => setMode('restore')}
              className="w-full h-11"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Restore from Backup
            </Button>

            <p className="text-center text-sm text-muted-foreground mt-6">
              Already registered?{" "}
              <Link to="/sign-in" className="text-brand hover:underline font-medium">
                Sign In
              </Link>
            </p>
          </Card>
        ) : (
          <Card className="p-8 border-warning-border bg-card shadow-[0_2px_10px_0_rgba(15,23,42,0.06)]">
            <button
              onClick={() => setMode('register')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to registration
            </button>

            <div className="mb-6">
              <h2 className="text-2xl font-bold tracking-tight">Restore from Backup</h2>
              <p className="text-sm text-warning mt-1 font-medium">
                Restore your God Hosting instance from a backup file.
              </p>
            </div>

            {error && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {bootstrapRequired && (
              <div className="mb-4">
                <label className="text-sm font-medium mb-1.5 block">
                  Bootstrap secret <span className="text-danger">*</span>
                </label>
                <Input
                  type="password"
                  value={formData.bootstrapSecret}
                  onChange={(e) => setFormData({ ...formData, bootstrapSecret: e.target.value })}
                  placeholder="From docker logs / data/.bootstrap-secret"
                  autoComplete="off"
                  className="h-11 font-mono text-sm"
                />
              </div>
            )}

            <div
              className={`rounded-lg border-2 border-dashed p-6 transition-colors ${
                isDragging
                  ? 'border-warning bg-warning-surface'
                  : 'border-warning-border bg-warning-surface/60'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="rounded-full border border-warning-border bg-card p-4">
                  <FileUp className={`h-8 w-8 text-warning ${isDragging ? 'animate-bounce' : ''}`} />
                </div>
                <div>
                  <p className="font-medium">
                    {isDragging ? 'Drop your backup file here' : 'Drag & drop or select a backup file'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {isDragging ? 'Release to upload' : 'Select a .zip backup file from your computer'}
                  </p>
                </div>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept=".zip"
                    onChange={handleRestoreFile}
                    className="hidden"
                    disabled={restoring}
                  />
                  <Button type="button" disabled={restoring} asChild>
                    <span>
                      {restoring ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4 mr-2" />
                      )}
                      Select Backup File
                    </span>
                  </Button>
                </label>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border bg-secondary p-3 text-sm">
              <p className="font-medium mb-2">Backup will restore:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 text-xs">
                <li>All user accounts and credentials</li>
                <li>Projects and deployments</li>
                <li>Environment variables</li>
                <li>Nginx configurations</li>
                <li>GitHub App settings</li>
              </ul>
            </div>

            <div className="mt-3 rounded-lg border border-brand/20 bg-brand/5 p-3 text-sm">
              <p className="font-medium text-brand mb-2">After restore:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 text-xs">
                <li>Sign in with your credentials from the backup</li>
                <li>Redeploy each project (containers need rebuilding)</li>
                <li>Update DNS if server IP changed</li>
                <li>GitHub App works automatically if using domain-based webhook URL</li>
              </ul>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
