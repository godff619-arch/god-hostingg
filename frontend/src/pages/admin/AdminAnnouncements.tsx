// Admin Announcements (/admin/announcements) — §22.
//
// The list answers two questions at a glance: is this thing live, and has anyone
// actually been told? They are different questions. `Published` makes a banner or
// modal eligible to appear; the inbox notice and the mail only exist once someone
// pressed Deliver. A row that is published but never delivered is a normal, valid
// state — and the reason "Live" and "Delivered" are separate columns rather than one
// status pill pretending to cover both.
//
// `live` is computed by the server (§61) from `published` plus the window, so this
// page never disagrees with what the customer's app decides to show.
//
// Delete asks twice, in the row, because there is no undo and no trash.

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import {
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Metric,
  MetricStrip,
  Pagination,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { AnnouncementEditorDialog } from "@/components/admin/AnnouncementEditorDialog";
import { AnnouncementDetailDialog } from "@/components/admin/AnnouncementDetailDialog";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { Announcement, AnnouncementsResponse } from "@/lib/adminCommsTypes";
import { announcementTone } from "@/lib/adminCommsTypes";
import { formatDateTime, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

const STATES: PillOption[] = [
  { value: "all", label: "All" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Drafts" },
];

/** `Live` / `Published, waiting` / `Expired` / `Draft` — from the server's own `live`. */
function stateBadge(a: Announcement) {
  if (!a.published) return { label: "Draft", tone: "neutral" as const };
  if (a.live) return { label: "Live", tone: "success" as const };
  if (a.ends_at && new Date(a.ends_at).getTime() < Date.now())
    return { label: "Expired", tone: "neutral" as const };
  return { label: "Scheduled", tone: "warning" as const };
}

function audienceLabel(a: Announcement): string {
  if (a.audience === "all") return "Everyone";
  const n = a.audience_ref.length;
  return `${humanize(a.audience)} · ${n} selected`;
}

export default function AdminAnnouncements() {
  const { can } = useAdminMe();
  const canManage = can("announcements.manage");

  const [data, setData] = useState<AnnouncementsResponse | null>(null);
  const [rows, setRows] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [state]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (state !== "all") params.set("state", state);
      const res = await adminGet<AnnouncementsResponse>(`/announcements?${params.toString()}`);
      setData(res);
      setRows(res.announcements);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load announcements");
    } finally {
      setLoading(false);
    }
  }, [state, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePublish = async (a: Announcement) => {
    setBusyId(a.id);
    try {
      await adminSend(`/announcements/${a.id}/publish`, "POST", { published: !a.published });
      toast.success(
        a.published
          ? `“${a.title}” unpublished — it will stop appearing.`
          : `“${a.title}” published. Nobody is notified until you press Deliver.`,
      );
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change that.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a: Announcement) => {
    setBusyId(a.id);
    try {
      await adminSend(`/announcements/${a.id}`, "DELETE");
      toast.success(`“${a.title}” deleted.`);
      setConfirmDelete(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete it.");
    } finally {
      setBusyId(null);
    }
  };

  const liveCount = rows.filter((a) => a.live).length;
  const draftCount = rows.filter((a) => !a.published).length;
  const emailCount = rows.filter((a) => a.send_email).length;

  return (
    <>
      <PageHeader
        title="Announcements"
        eyebrow="Communications"
        description="Banners, modals and inbox notices, addressed to everyone or to one plan, role or account. Publishing makes it visible; delivering is what tells people."
        icon={Megaphone}
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
            </Button>
            {canManage && (
              <Button onClick={() => setComposing(true)}>
                <Plus className="h-4 w-4" /> New announcement
              </Button>
            )}
          </>
        }
      />

      <MetricStrip>
        <Metric
          label="Total"
          value={data?.total ?? 0}
          hint="Matching this filter"
          loading={loading}
        />
        <Metric
          label="Live now"
          value={liveCount}
          tone={liveCount > 0 ? "success" : "neutral"}
          hint="On this page — published and inside its window"
          loading={loading}
        />
        <Metric label="Drafts" value={draftCount} hint="On this page — nobody can see these" loading={loading} />
        <Metric
          label="Also emailed"
          value={emailCount}
          tone={emailCount > 0 ? "info" : "neutral"}
          hint="On this page — mail is written on delivery"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4">
        <FilterPills options={STATES} value={state} onChange={setState} />
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading && rows.length === 0 ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No announcements here."
          hint={
            state !== "all"
              ? "Clear the filter to see the rest."
              : canManage
                ? "Compose one with “New announcement”. It stays a draft until you publish it."
                : "Nothing has been written yet."
          }
        />
      ) : (
        <>
          <div className="space-y-3 stagger-in">
            {rows.map((a) => {
              const badge = stateBadge(a);
              const busy = busyId === a.id;
              return (
                <article
                  key={a.id}
                  className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <button
                      type="button"
                      onClick={() => setOpenId(a.id)}
                      className="min-w-0 flex-1 text-left"
                      title="Open, resolve the audience and deliver"
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        <ToneBadge label={badge.label} tone={badge.tone} />
                        <ToneBadge label={humanize(a.level)} tone={announcementTone(a.level)} />
                        <ToneBadge label={humanize(a.placement)} />
                        {a.send_email && <ToneBadge label="Emailed" tone="info" />}
                      </span>
                      <h3 className="mt-2 truncate text-sm font-bold">{a.title}</h3>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.body}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground/80">
                        {audienceLabel(a)} · created {formatDateTime(a.created_at)}
                        {a.starts_at || a.ends_at
                          ? ` · ${a.starts_at ? formatDateTime(a.starts_at) : "now"} → ${
                              a.ends_at ? formatDateTime(a.ends_at) : "no end"
                            }`
                          : ""}
                      </p>
                    </button>

                    {canManage && (
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          variant={a.published ? "ghost" : "success"}
                          size="sm"
                          onClick={() => togglePublish(a)}
                          disabled={busy}
                        >
                          {a.published ? "Unpublish" : "Publish"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditing(a)}>
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                        {confirmDelete === a.id ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => remove(a)}
                              disabled={busy}
                            >
                              Delete for good
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete"
                            onClick={() => setConfirmDelete(a.id)}
                            className="h-8 w-8 text-muted-foreground hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            noun="announcements"
            onPage={setPage}
          />
        </>
      )}

      {(composing || editing) && data && (
        <AnnouncementEditorDialog
          announcement={editing}
          levels={data.levels}
          audiences={data.audiences}
          placements={data.placements}
          plans={data.plans}
          onClose={() => {
            setComposing(false);
            setEditing(null);
          }}
          onSaved={load}
        />
      )}

      {openId && (
        <AnnouncementDetailDialog
          id={openId}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onDelivered={load}
        />
      )}
    </>
  );
}
