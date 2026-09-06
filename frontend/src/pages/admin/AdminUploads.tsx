// Admin Uploads (/admin/uploads) — operator-visible archive of user ZIP uploads.
// Every ZIP a user uploads to create a project is copied here so an admin can
// inspect or download exactly what was uploaded.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, RefreshCw, Download, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { adminGet, adminSend } from "@/lib/adminApi";
import { ListError, ListSkeleton, ListEmpty } from "@/components/admin/AdminList";
import { authFetch } from "@/lib/auth";
import { API_URL } from "@/lib/utils";

interface UploadRow {
  id: string;
  originalName: string;
  sizeFormatted: string;
  userId: string | null;
  userEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  uploadedAt: string;
}

interface UploadsResponse {
  uploads: UploadRow[];
  total: number;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function AdminUploads() {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchUploads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<UploadsResponse>("/uploads");
      setRows(res.uploads);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load uploads");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  const handleDownload = async (row: UploadRow) => {
    setBusy(row.id);
    try {
      const res = await authFetch(`${API_URL}/api/admin/uploads/${row.id}/download`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = row.originalName || `${row.id}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (row: UploadRow) => {
    if (!window.confirm(`Delete archived upload "${row.originalName}"? This cannot be undone.`)) {
      return;
    }
    setBusy(row.id);
    try {
      await adminSend(`/uploads/${row.id}`, "DELETE");
      toast.success("Upload deleted");
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Uploads"
        description="Archived copies of every ZIP users upload to create a project."
        icon={Archive}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchUploads}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      />

      {error && <ListError message={error} onRetry={fetchUploads} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty message="No uploads archived yet." hint="ZIP uploads from the New project flow will appear here." />
      ) : (
        <>
          {/* Mobile cards */}
          <div className="stagger-in space-y-3 lg:hidden">
            {rows.map((u) => (
              <article key={u.id} className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{u.originalName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.userEmail || "Unknown user"}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {u.sizeFormatted}
                  </span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {u.projectId ? (
                    <Link to={`/projects/${u.projectId}`} className="hover:text-brand hover:underline">
                      {u.projectName || u.projectId}
                    </Link>
                  ) : (
                    <span>{u.projectName || "—"}</span>
                  )}
                  <span> · {formatDateTime(u.uploadedAt)}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5 border-border/60"
                    disabled={busy === u.id}
                    onClick={() => handleDownload(u)}
                  >
                    {busy === u.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-border/60 text-danger hover:bg-danger-surface"
                    disabled={busy === u.id}
                    onClick={() => handleDelete(u)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </article>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">File</th>
                    <th className="px-4 py-3 font-semibold">User</th>
                    <th className="px-4 py-3 font-semibold">Project</th>
                    <th className="px-4 py-3 font-semibold">Size</th>
                    <th className="px-4 py-3 font-semibold">Uploaded</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40">
                      <td className="px-4 py-3 font-medium">{u.originalName}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {u.userId ? (
                          <Link to={`/admin/users/${u.userId}`} className="hover:text-brand hover:underline">
                            {u.userEmail || u.userId}
                          </Link>
                        ) : (
                          u.userEmail || "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {u.projectId ? (
                          <Link to={`/projects/${u.projectId}`} className="hover:text-brand hover:underline">
                            {u.projectName || u.projectId}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{u.projectName || "—"}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{u.sizeFormatted}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{formatDateTime(u.uploadedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 border-border/60"
                            title="Download"
                            disabled={busy === u.id}
                            onClick={() => handleDownload(u)}
                          >
                            {busy === u.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 border-border/60 text-danger hover:bg-danger-surface"
                            title="Delete"
                            disabled={busy === u.id}
                            onClick={() => handleDelete(u)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
