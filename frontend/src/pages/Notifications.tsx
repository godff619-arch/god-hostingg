// Notifications — the Part A sidebar entry under INTEGRATIONS, plus the delivery
// preferences and outbound channels the spec puts on the same page.
//
// Three panels. Preferences and channels belong to the workspace; the feed below
// belongs to the signed-in user, so "mark all read" and "clear" only ever touch
// their own rows. A channel's destination URL is itself a credential (a Slack
// incoming-webhook URL is all you need to post), so the API returns only its host
// as `hint` — this page offers "replace", never "reveal".
//
// There is no email channel because this deployment has no mailer configured; a
// toggle that silently did nothing would be worse than its absence.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Info,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Slack,
  Trash2,
  Webhook,
  XCircle,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type {
  NotificationChannelRow,
  NotificationEvent,
  NotificationLevel,
  NotificationRow,
  NotificationsPayload,
} from "@/lib/workspaceTypes";

/** Labels for the event keys the server advertises. */
const EVENT_LABELS: Record<string, { title: string; hint: string }> = {
  "deploy.succeeded": {
    title: "Deploy succeeded",
    hint: "A service finished deploying without errors.",
  },
  "deploy.failed": { title: "Deploy failed", hint: "A build or deploy did not complete." },
  "service.suspended": {
    title: "Service suspended",
    hint: "A service was stopped by the platform.",
  },
  "quota.exceeded": { title: "Plan limit reached", hint: "A create was refused by a plan limit." },
  billing: { title: "Billing", hint: "Invoices, payment methods and plan changes." },
  system: { title: "System", hint: "Platform maintenance and incident notices." },
};

/** Events the server always delivers — the checkbox for these is informational. */
const ALWAYS_ON: ReadonlySet<string> = new Set(["quota.exceeded", "billing", "system"]);

const LEVELS: Array<{ value: NotificationLevel; label: string; hint: string }> = [
  { value: "all", label: "All activity", hint: "Every deploy and service state change." },
  { value: "failure", label: "Failures only", hint: "Only the things that went wrong." },
  { value: "none", label: "Nothing", hint: "Silence the lifecycle entirely." },
];

function eventLabel(event: string): { title: string; hint: string } {
  return EVENT_LABELS[event] ?? { title: event, hint: "" };
}

function timeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Notifications() {
  const [data, setData] = useState<NotificationsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = `page=${page}${unreadOnly ? "&unread=true" : ""}`;
      setData(await apiGet<NotificationsPayload>(scoped(`/api/notifications?${query}`)));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      const result = await apiSend<{ marked: number }>(
        scoped("/api/notifications/read-all"),
        "POST",
      );
      toast.success(
        result.marked === 0
          ? "Nothing was unread"
          : `Marked ${result.marked} notification${result.marked === 1 ? "" : "s"} read`,
      );
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearFeed = async () => {
    setBusy(true);
    try {
      const result = await apiSend<{ removed: number }>(scoped("/api/notifications"), "DELETE");
      toast.success(
        result.removed === 0
          ? "The feed was already empty"
          : `Removed ${result.removed} notification${result.removed === 1 ? "" : "s"}`,
      );
      setClearOpen(false);
      setPage(1);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[960px] space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-56 animate-pulse rounded-md border border-border bg-card" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load notifications."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(data.total / data.page_size));

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[27px] font-medium leading-tight text-foreground">Notifications</h1>
        <Button
          variant="bare"
          size="icon"
          aria-label="Refresh notifications"
          className="hover:bg-hover"
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Choose what {data.workspace.name} notifies about, where those notices are delivered, and
        read the ones addressed to you. Plan limits, billing and platform notices always arrive.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      <div className="mt-6 space-y-4">
        <PreferencesPanel
          settings={data.settings}
          availableEvents={data.available_events}
          onChanged={load}
        />
        <ChannelsPanel
          channels={data.channels}
          kinds={data.channel_kinds}
          onAdd={() => setAddOpen(true)}
          onChanged={load}
        />
        <FeedPanel
          rows={data.notifications}
          total={data.total}
          unread={data.unread}
          page={data.page}
          pageCount={pageCount}
          unreadOnly={unreadOnly}
          busy={busy}
          onPage={setPage}
          onUnreadOnly={(value) => {
            setPage(1);
            setUnreadOnly(value);
          }}
          onMarkAllRead={markAllRead}
          onClear={() => setClearOpen(true)}
          onChanged={load}
        />
      </div>

      <ChannelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        kinds={data.channel_kinds}
        channel={null}
        onDone={load}
      />

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear your feed?</DialogTitle>
            <DialogDescription>
              This removes every notification addressed to you in {data.workspace.name}, read or
              not. Preferences and channels are untouched, and it only affects your own feed — other
              members keep theirs.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void clearFeed()}>
              {busy ? "Clearing…" : "Clear feed"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Delivery preferences. `saved: false` means the platform defaults are still in
 * force, which the panel says out loud rather than implying a stored choice.
 */
function PreferencesPanel({
  settings,
  availableEvents,
  onChanged,
}: {
  settings: NotificationsPayload["settings"];
  availableEvents: NotificationEvent[];
  onChanged: () => Promise<void>;
}) {
  const [level, setLevel] = useState<NotificationLevel>(settings.default_level);
  const [includePreview, setIncludePreview] = useState(settings.include_preview);
  const [events, setEvents] = useState<NotificationEvent[]>(settings.events);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  // The server's copy wins after any reload, so a reset or another member's save
  // is reflected instead of leaving stale form state behind.
  useEffect(() => {
    setLevel(settings.default_level);
    setIncludePreview(settings.include_preview);
    setEvents(settings.events);
  }, [settings]);

  const dirty =
    level !== settings.default_level ||
    includePreview !== settings.include_preview ||
    events.length !== settings.events.length ||
    events.some((event) => !settings.events.includes(event));

  const toggle = (event: NotificationEvent) => {
    setEvents((current) =>
      current.includes(event) ? current.filter((e) => e !== event) : [...current, event],
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiSend(scoped("/api/notifications/settings"), "PATCH", {
        default_level: level,
        include_preview: includePreview,
        events,
      });
      toast.success("Notification preferences saved");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      await apiSend(scoped("/api/notifications/settings"), "DELETE");
      toast.success("Back to the platform defaults");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="flex min-w-0 gap-2.5">
          <Bell className="mt-[3px] h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium text-foreground">Preferences</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              What this workspace notifies about, for every member.
            </p>
          </div>
        </div>
        {!settings.saved ? (
          <span className="rounded-[3px] border border-border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            Using defaults
          </span>
        ) : null}
      </div>

      <div className="space-y-4 p-4">
        <div className="space-y-1.5">
          <span className="text-[12px] text-muted-foreground">Deploy and service activity</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {LEVELS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                  level === option.value
                    ? "border-brand-ring bg-secondary/40"
                    : "border-border hover:bg-hover",
                )}
              >
                <input
                  type="radio"
                  name="notification-level"
                  value={option.value}
                  checked={level === option.value}
                  onChange={() => setLevel(option.value)}
                  className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
                />
                <span className="min-w-0">
                  <span className="block text-[12px] text-foreground">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
          <input
            type="checkbox"
            checked={includePreview}
            onChange={(e) => setIncludePreview(e.target.checked)}
            className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
          />
          <span className="min-w-0">
            <span className="block text-[12px] text-foreground">Include preview environments</span>
            <span className="block text-[11px] text-muted-foreground">
              Without this, only the default environment's deploys notify.
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <span className="text-[12px] text-muted-foreground">Events</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {availableEvents.map((event) => {
              const meta = eventLabel(event);
              const always = ALWAYS_ON.has(event);
              return (
                <label
                  key={event}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5",
                    always ? "cursor-default opacity-80" : "cursor-pointer hover:bg-hover",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={always || events.includes(event)}
                    disabled={always}
                    onChange={() => toggle(event)}
                    className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] text-foreground">{meta.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {always ? "Always delivered — account-critical." : meta.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="text-[11px] text-subtle">
            Plan limits, billing and platform notices ignore these settings by design.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              // Nothing to reset until the workspace has actually saved once.
              disabled={resetting || !settings.saved}
              onClick={() => void reset()}
            >
              {resetting ? "Resetting…" : "Reset to defaults"}
            </Button>
            <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The workspace's outbound destinations. Only the host is ever shown. */
function ChannelsPanel({
  channels,
  kinds,
  onAdd,
  onChanged,
}: {
  channels: NotificationChannelRow[];
  kinds: Array<"slack" | "webhook">;
  onAdd: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="flex min-w-0 gap-2.5">
          <Send className="mt-[3px] h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium text-foreground">Delivery channels</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Post every notice to Slack or your own endpoint. The in-app feed below is always on.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          Add channel
        </Button>
      </div>

      {channels.length === 0 ? (
        <div className="p-8 text-center">
          <Webhook
            className="mx-auto h-5 w-5 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden
          />
          <p className="mt-2 text-[14px] text-foreground">No channels yet</p>
          <p className="mx-auto mt-1 max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
            Add a Slack incoming webhook or an https endpoint of your own and every subscribed event
            is posted to it as it happens.
          </p>
        </div>
      ) : (
        <ul>
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              kinds={kinds}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelRow({
  channel,
  kinds,
  onChanged,
}: {
  channel: NotificationChannelRow;
  kinds: Array<"slack" | "webhook">;
  onChanged: () => Promise<void>;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = channel.kind === "slack" ? Slack : Webhook;

  const send = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    try {
      return await apiSend<{ ok?: boolean; duration_ms?: number }>(
        scoped(`/api/notifications/channels/${channel.id}${path}`),
        method,
        body,
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    try {
      await send("", "PATCH", { enabled: !channel.enabled });
      toast.success(channel.enabled ? `${channel.name} paused` : `${channel.name} enabled`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const test = async () => {
    try {
      const result = await send("/test", "POST");
      if (result.ok) toast.success(`Delivered to ${channel.hint} in ${result.duration_ms} ms`);
      else toast.error(`${channel.hint} did not accept the message`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      await send("", "DELETE");
      toast.success(`${channel.name} removed`);
      setDeleteOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{channel.name}</span>
          {!channel.enabled ? (
            <span className="rounded-[3px] border border-border px-1.5 py-[1px] text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Paused
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {/* The full URL is a credential, so only its host comes back from the API. */}
          <span>{channel.hint}</span>
          {channel.last_result && channel.last_sent_at ? (
            <span className="flex items-center gap-1">
              {channel.last_result === "ok" ? (
                <CheckCircle2 className="h-3 w-3 text-success" strokeWidth={1.75} />
              ) : (
                <XCircle className="h-3 w-3 text-danger" strokeWidth={1.75} />
              )}
              last delivery {channel.last_result === "ok" ? "succeeded" : "failed"} ·{" "}
              {timeLabel(channel.last_sent_at)}
            </span>
          ) : (
            <span className="text-subtle">nothing sent yet</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void test()}>
          {busy ? "Working…" : "Test"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleEnabled()}>
          {channel.enabled ? "Pause" : "Enable"}
        </Button>
        <Button
          variant="bare"
          size="icon"
          aria-label={`Edit ${channel.name}`}
          className="hover:bg-hover"
          onClick={() => setEditOpen(true)}
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
        <Button
          variant="bare"
          size="icon"
          aria-label={`Delete ${channel.name}`}
          className="text-muted-foreground hover:bg-hover hover:text-danger"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </div>

      <ChannelDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        kinds={kinds}
        channel={channel}
        onDone={onChanged}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {channel.name}?</DialogTitle>
            <DialogDescription>
              Notices stop being posted to {channel.hint}. The stored destination is deleted with it,
              so adding the channel back means entering the URL again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/**
 * Add or re-point a channel. On edit the URL field starts empty and is only sent
 * when filled, because the stored destination can never be read back to prefill it.
 */
function ChannelDialog({
  open,
  onOpenChange,
  kinds,
  channel,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kinds: Array<"slack" | "webhook">;
  channel: NotificationChannelRow | null;
  onDone: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"slack" | "webhook">(channel?.kind ?? kinds[0] ?? "slack");
  const [name, setName] = useState(channel?.name ?? "");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(channel?.kind ?? kinds[0] ?? "slack");
    setName(channel?.name ?? "");
    setTarget("");
  }, [open, channel, kinds]);

  const trimmedName = name.trim();
  const trimmedTarget = target.trim();
  const urlLooksWrong = trimmedTarget.length > 0 && !trimmedTarget.startsWith("https://");
  const blocked =
    !trimmedName ||
    trimmedName.length > 60 ||
    urlLooksWrong ||
    // A new channel has nothing stored yet, so the URL is mandatory there only.
    (!channel && trimmedTarget.length === 0);

  const submit = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      if (channel) {
        await apiSend(scoped(`/api/notifications/channels/${channel.id}`), "PATCH", {
          name: trimmedName,
          ...(trimmedTarget ? { target: trimmedTarget } : {}),
        });
        toast.success(`${trimmedName} updated`);
      } else {
        await apiSend(scoped("/api/notifications/channels"), "POST", {
          kind,
          name: trimmedName,
          target: trimmedTarget,
        });
        toast.success(`${trimmedName} added`);
      }
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{channel ? `Edit ${channel.name}` : "Add a delivery channel"}</DialogTitle>
          <DialogDescription>
            {channel
              ? "The stored destination is never returned by the API. Leave the URL blank to keep it."
              : "Slack posts a formatted message; a webhook receives the notice as JSON."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!channel ? (
            <div className="space-y-1.5">
              <label htmlFor="channel-kind" className="text-[12px] text-muted-foreground">
                Type
              </label>
              <select
                id="channel-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "slack" | "webhook")}
                className="h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
              >
                {kinds.map((option) => (
                  <option key={option} value={option} className="bg-card">
                    {option === "slack" ? "Slack" : "Webhook (JSON)"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="channel-name" className="text-[12px] text-muted-foreground">
              Name
            </label>
            <Input
              id="channel-name"
              value={name}
              maxLength={60}
              placeholder="Engineering alerts"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="channel-target" className="text-[12px] text-muted-foreground">
              Destination URL
            </label>
            <Input
              id="channel-target"
              value={target}
              autoComplete="off"
              placeholder={
                channel
                  ? `Configured — ${channel.hint}. Enter a new URL to replace it`
                  : kind === "slack"
                    ? "https://hooks.slack.com/services/…"
                    : "https://example.com/hooks/docklift"
              }
              onChange={(e) => setTarget(e.target.value)}
            />
            {urlLooksWrong ? (
              <p className="text-[11px] text-danger">The destination must be an https:// URL.</p>
            ) : (
              <p className="text-[11px] text-subtle">
                Stored encrypted and never returned by the API — only its host is shown.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving || blocked} onClick={() => void submit()}>
            {saving ? "Saving…" : channel ? "Save channel" : "Add channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The signed-in user's own feed. Nobody else's rows are reachable from here. */
function FeedPanel({
  rows,
  total,
  unread,
  page,
  pageCount,
  unreadOnly,
  busy,
  onPage,
  onUnreadOnly,
  onMarkAllRead,
  onClear,
  onChanged,
}: {
  rows: NotificationRow[];
  total: number;
  unread: number;
  page: number;
  pageCount: number;
  unreadOnly: boolean;
  busy: boolean;
  onPage: (page: number) => void;
  onUnreadOnly: (value: boolean) => void;
  onMarkAllRead: () => Promise<void>;
  onClear: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="flex min-w-0 gap-2.5">
          <Inbox className="mt-[3px] h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium text-foreground">Your feed</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {total === 0
                ? "Nothing addressed to you in this workspace."
                : `${total} notification${total === 1 ? "" : "s"}${unread > 0 ? ` · ${unread} unread` : ""}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => onUnreadOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-[hsl(var(--brand))]"
            />
            Unread only
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || unread === 0}
            onClick={() => void onMarkAllRead()}
          >
            <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
            Mark all read
          </Button>
          <Button variant="outline" size="sm" disabled={busy || total === 0} onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center">
          <BellOff className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          <p className="mt-2 text-[14px] text-foreground">
            {unreadOnly ? "Nothing unread" : "No notifications yet"}
          </p>
          <p className="mx-auto mt-1 max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
            {unreadOnly
              ? "Everything addressed to you in this workspace has been read."
              : "Deploy results, plan limits and platform notices will appear here as they happen."}
          </p>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <FeedRow key={row.id} row={row} onChanged={onChanged} />
          ))}
        </ul>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="text-[11px] text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => onPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Severity decides the icon and its colour; the server sets it, never the client. */
function severityIcon(severity: NotificationRow["severity"]) {
  if (severity === "error") return { Icon: XCircle, className: "text-danger" };
  if (severity === "warning") return { Icon: AlertTriangle, className: "text-warning" };
  return { Icon: Info, className: "text-muted-foreground" };
}

function FeedRow({ row, onChanged }: { row: NotificationRow; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { Icon, className } = severityIcon(row.severity);
  const unread = row.read_at === null;

  const markRead = async () => {
    setBusy(true);
    try {
      await apiSend(`/api/notifications/${row.id}/read`, "POST");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiSend(`/api/notifications/${row.id}`, "DELETE");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={cn(
        "flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0",
        unread ? "bg-secondary/25" : null,
      )}
    >
      <Icon className={cn("mt-[2px] h-4 w-4 shrink-0", className)} strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[13px]",
              unread ? "font-medium text-foreground" : "text-foreground",
            )}
          >
            {row.title}
          </span>
          {unread ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
              aria-label="Unread"
              role="img"
            />
          ) : null}
        </div>
        {row.body ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{row.body}</p>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-subtle">
          <span>{eventLabel(row.type).title}</span>
          <span>·</span>
          <span>{timeLabel(row.created_at)}</span>
          {row.link ? (
            <>
              <span>·</span>
              <Link
                to={row.link}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                Open
                <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
              </Link>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {unread ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void markRead()}>
            Mark read
          </Button>
        ) : null}
        <Button
          variant="bare"
          size="icon"
          aria-label={`Delete notification: ${row.title}`}
          className="text-muted-foreground hover:bg-hover hover:text-danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </div>
    </li>
  );
}
