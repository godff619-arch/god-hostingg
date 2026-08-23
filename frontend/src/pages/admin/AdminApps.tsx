// Admin Apps (/admin/apps) — platform-wide application list with lifecycle actions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Boxes,
  Search,
  RefreshCw,
  Square,
  RotateCw,
  Rocket,
  Trash2,
  Settings2,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminGet, apiSend } from "@/lib/adminApi";
import type { AppRow as AdminApp } from "@/lib/adminTypes";
import { cn } from "@/lib/utils";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

type ActionKind = "stop" | "restart" | "redeploy";

export default function AdminApps() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteApp, setDeleteApp] = useState<AdminApp | null>(null);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<AdminApp[]>("/apps");
      setApps(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load applications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    apps.forEach((a) => a.status && set.add(a.status));
    return ["all", ...Array.from(set).sort()];
  }, [apps]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return apps.filter((a) => {
      if (status !== "all" && a.status !== status) return false;
      if (!term) return true;
      return (
        a.name.toLowerCase().includes(term) ||
        (a.owner?.name.toLowerCase().includes(term) ?? false) ||
        (a.owner?.email.toLowerCase().includes(term) ?? false)
      );
    });
  }, [apps, q, status]);

  const runAction = async (app: AdminApp, kind: ActionKind) => {
    setBusyId(app.id);
    try {
      await apiSend(`/api/deployments/${app.id}/${kind}`, "POST");
      toast.success(`${kind[0].toUpperCase()}${kind.slice(1)} triggered for ${app.name}`);
      fetchApps();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${kind}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteApp) return;
    setBusyId(deleteApp.id);
    try {
      await apiSend(`/api/projects/${deleteApp.id}`, "DELETE");
      toast.success(`Deleted ${deleteApp.name}`);
      setDeleteApp(null);
      fetchApps();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete application");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every application across the platform, with lifecycle controls."
        icon={Boxes}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchApps}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by app name or owner…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-xl border px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                status === s
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          No applications match these filters.
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-3 lg:hidden">
            {filtered.map((app) => (
              <article key={app.id} className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{app.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {app.owner ? `${app.owner.name} · ${app.owner.email}` : "Unowned"}
                    </p>
                  </div>
                  <StatusBadge status={app.container_status || app.status} size="sm" />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{app.source_type}/{app.build_type}</span>
                  {app.domain && <span className="truncate">{app.domain}</span>}
                  <span>{formatDate(app.created_at)}</span>
                </div>
                <AppActions
                  app={app}
                  busy={busyId === app.id}
                  onAction={runAction}
                  onDelete={() => setDeleteApp(app)}
                  className="mt-3 border-t border-border/40 pt-3"
                />
              </article>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Application</th>
                    <th className="px-4 py-3 font-semibold">Owner</th>
                    <th className="px-4 py-3 font-semibold">Runtime</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Domain</th>
                    <th className="px-4 py-3 font-semibold">Last deploy</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((app) => (
                    <tr key={app.id} className="border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40">
                      <td className="px-4 py-3">
                        <Link to={`/projects/${app.id}`} className="font-semibold hover:text-brand hover:underline">
                          {app.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{formatDate(app.created_at)}</p>
                      </td>
                      <td className="px-4 py-3">
                        {app.owner ? (
                          <>
                            <p className="font-medium">{app.owner.name}</p>
                            <p className="text-xs text-muted-foreground">{app.owner.email}</p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Unowned</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {app.source_type}
                        <span className="mx-1 text-border">/</span>
                        {app.build_type}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={app.container_status || app.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {app.domain ? (
                          <a
                            href={`https://${app.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-brand hover:underline"
                          >
                            <span className="max-w-[160px] truncate">{app.domain}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {app.last_deployment ? (
                          <div className="flex items-center gap-2">
                            <StatusBadge status={app.last_deployment.status} size="sm" />
                            <span className="text-xs text-muted-foreground">
                              {formatDate(app.last_deployment.created_at)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <AppActions
                          app={app}
                          busy={busyId === app.id}
                          onAction={runAction}
                          onDelete={() => setDeleteApp(app)}
                          className="justify-end"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Dialog open={deleteApp !== null} onOpenChange={(o) => !o && setDeleteApp(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10">
              <Trash2 className="h-6 w-6 text-red-500" />
            </div>
            <DialogTitle className="text-center">Delete application</DialogTitle>
            <DialogDescription className="text-center">
              Permanently delete <span className="font-semibold text-foreground">{deleteApp?.name}</span>{" "}
              and its containers? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setDeleteApp(null)} className="flex-1">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={busyId === deleteApp?.id}
              className="flex-1"
            >
              {busyId === deleteApp?.id && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AppActions({
  app,
  busy,
  onAction,
  onDelete,
  className,
}: {
  app: AdminApp;
  busy: boolean;
  onAction: (app: AdminApp, kind: ActionKind) => void;
  onDelete: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin text-muted-foreground" />}
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="Stop"
        disabled={busy}
        onClick={() => onAction(app, "stop")}
      >
        <Square className="h-4 w-4 text-amber-500" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="Restart"
        disabled={busy}
        onClick={() => onAction(app, "restart")}
      >
        <RotateCw className="h-4 w-4 text-blue-500" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="Redeploy"
        disabled={busy}
        onClick={() => onAction(app, "redeploy")}
      >
        <Rocket className="h-4 w-4 text-emerald-500" />
      </Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" title="Manage" asChild>
        <Link to={`/projects/${app.id}`}>
          <Settings2 className="h-4 w-4" />
        </Link>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="Delete"
        disabled={busy}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4 text-red-500" />
      </Button>
    </div>
  );
}
