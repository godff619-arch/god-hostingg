// One announcement, and the act of delivering it — §22.
//
// Delivery is irreversible in the way that matters: you cannot un-notify someone, and
// you certainly cannot un-send a mail. So this dialog leads with the number of people
// it resolves to *right now* and requires a second press to go ahead. The audience is
// recomputed by the server on open, because "all active accounts" is a moving target.
//
// It also shows what has already been delivered. Pressing Deliver twice is safe — the
// server skips anyone who already has this in their feed, and any address it has
// already mailed — but an operator should be able to see that before they gamble on it.
//
// The result is reported in the server's own terms: `notified` and `already_notified`
// are separate numbers, and `queued_emails` is separate from `sent_now`, because a
// queued mail has not been delivered to anyone.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone, Send, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DetailRow, ListError, ListSkeleton, ToneBadge } from "@/components/admin/AdminList";
import { adminSend, adminGet } from "@/lib/adminApi";
import type { AnnouncementDetail, DeliverResult } from "@/lib/adminCommsTypes";
import { announcementTone } from "@/lib/adminCommsTypes";
import { formatDateTime, humanize } from "@/lib/adminFormat";

export function AnnouncementDetailDialog({
  id,
  canManage,
  onClose,
  onDelivered,
}: {
  id: string;
  canManage: boolean;
  onClose: () => void;
  onDelivered: () => void;
}) {
  const [data, setData] = useState<AnnouncementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [delivering, setDelivering] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminGet<AnnouncementDetail>(`/announcements/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that announcement");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const deliver = async () => {
    setDelivering(true);
    try {
      const res = await adminSend<DeliverResult>(`/announcements/${id}/deliver`, "POST");
      // The server's message already distinguishes queued from sent; don't rewrite it.
      if (res.queued_emails > 0 && res.sent_now === 0) toast.warning(res.message);
      else toast.success(res.message);
      setConfirming(false);
      await load();
      onDelivered();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Nothing was delivered.");
    } finally {
      setDelivering(false);
    }
  };

  const a = data?.announcement;
  const size = data?.audience.size ?? 0;
  const undelivered = Math.max(0, size - (data?.delivered.inbox ?? 0));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2">
            <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <span className="min-w-0 break-words">{a?.title ?? "Announcement"}</span>
          </DialogTitle>
          <DialogDescription>
            {a
              ? `${humanize(a.placement)} · ${a.audience === "all" ? "everyone" : humanize(a.audience)}`
              : "Resolving the audience…"}
          </DialogDescription>
        </DialogHeader>

        {error && <ListError message={error} onRetry={load} />}
        {!a && !error && <ListSkeleton rows={4} />}

        {a && data && (
          <div className="space-y-4">
            <p className="whitespace-pre-wrap rounded-2xl border border-border/60 bg-secondary/20 px-4 py-3 text-sm">
              {a.body}
            </p>

            <div className="rounded-2xl border border-border/60 bg-card px-4 py-2">
              <DetailRow label="Level">
                <ToneBadge label={humanize(a.level)} tone={announcementTone(a.level)} />
              </DetailRow>
              <DetailRow label="State">
                <ToneBadge
                  label={a.published ? (a.live ? "Live" : "Published, outside its window") : "Draft"}
                  tone={a.published ? (a.live ? "success" : "warning") : "neutral"}
                />
              </DetailRow>
              <DetailRow label="Audience">
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-semibold tabular-nums">{size}</span>
                  <span className="text-xs text-muted-foreground">
                    account{size === 1 ? "" : "s"} right now
                  </span>
                </span>
              </DetailRow>
              <DetailRow label="Window">
                {a.starts_at || a.ends_at
                  ? `${a.starts_at ? formatDateTime(a.starts_at) : "now"} → ${
                      a.ends_at ? formatDateTime(a.ends_at) : "no end"
                    }`
                  : "Always, while published"}
              </DetailRow>
              <DetailRow label="Email">
                {a.send_email ? "One mail per recipient on delivery" : "Not requested"}
              </DetailRow>
              <DetailRow label="Delivered">
                <span className="block tabular-nums">{data.delivered.inbox} inbox notice(s)</span>
                <span className="block text-xs tabular-nums text-muted-foreground">
                  {data.delivered.email} mail row(s) written
                </span>
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(a.created_at)}</DetailRow>
            </div>

            {data.audience.sample.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  Who this resolves to {size > data.audience.sample.length && `(first ${data.audience.sample.length})`}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.audience.sample.map((u) => (
                    <span
                      key={u.id}
                      className="max-w-full truncate rounded-full border border-border/60 bg-secondary/40 px-2.5 py-1 text-[11px] text-muted-foreground"
                      title={u.email}
                    >
                      {u.email}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {size === 0 && (
              <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2.5 text-xs text-warning">
                This audience currently resolves to nobody, so there is nothing to deliver.
              </p>
            )}

            {!a.published && (
              <p className="rounded-xl border border-warning-border bg-warning-surface px-3 py-2.5 text-xs text-warning">
                It is still a draft. Publish it first — delivering an unpublished announcement is
                refused by the server.
              </p>
            )}

            {confirming && (
              <div className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2.5 text-xs text-danger">
                This posts a notice to <strong>{undelivered}</strong> account
                {undelivered === 1 ? "" : "s"} that have not had it yet
                {a.send_email ? " and writes them a mail" : ""}. It cannot be undone.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={delivering}>
            Close
          </Button>
          {a && canManage && a.published && size > 0 && (
            <Button
              variant={confirming ? "destructive" : "default"}
              onClick={() => (confirming ? deliver() : setConfirming(true))}
              disabled={delivering}
            >
              {delivering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {confirming ? "Yes, deliver it now" : "Deliver"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
