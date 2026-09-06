// Webhooks — spec Part C §55–§60.
//
// Pro feature. Whether it is unlocked is decided by the server (`unlocked` +
// `required_plan` on the payload, 403 `PLAN_LOCKED` on write), and rendered by
// <PlanLockedCard/>, so this page never hardcodes "webhooks need Pro".
//
// The signing secret is shown exactly once, at creation. Afterwards the API only
// reports that one is configured, so there is nothing here that could leak it.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  RefreshCw,
  Trash2,
  Webhook as WebhookIcon,
} from "lucide-react";
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
import { PlanBadge, PlanLockedCard } from "@/components/workspace/PlanGate";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { copyToClipboard, cn } from "@/lib/utils";
import type { WebhookRow, WebhooksPayload } from "@/lib/workspaceTypes";

/** Machine event id → the label the spec spells out for the checkbox list. */
const EVENT_LABELS: Record<string, string> = {
  "deploy.started": "Deploy Started",
  "deploy.finished": "Deploy Finished",
  "deploy.failed": "Deploy Failed",
  "service.created": "Service Created",
  "service.deleted": "Service Deleted",
  "service.suspended": "Service Suspended",
  "service.health_changed": "Service Health Changed",
};

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

const USE_CASES = [
  {
    title: "Notify your team",
    body: "Post to Slack, Discord or Teams the moment a deploy finishes or fails.",
  },
  {
    title: "Trigger downstream jobs",
    body: "Kick off smoke tests, cache warming or a CDN purge after every release.",
  },
  {
    title: "Track health changes",
    body: "Record every suspension and health transition in your own incident tooling.",
  },
];

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Webhooks() {
  const [data, setData] = useState<WebhooksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<WebhooksPayload>(scoped("/api/integrations/webhooks")));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[960px] space-y-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-secondary/50" />
        <div className="h-28 animate-pulse rounded-md border border-border bg-card" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load webhooks."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[27px] font-medium leading-tight text-foreground">Webhooks</h1>
          <PlanBadge tier={data.required_plan} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh webhooks"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          {data.unlocked ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New webhook
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 max-w-[640px] text-[13px] text-muted-foreground">
        Send an HTTP POST to your own endpoint whenever something happens in this workspace. Every
        request is signed with the webhook's secret.
      </p>
      <div className="mt-5 h-px w-full bg-border" />

      {data.unlocked ? (
        <div className="mt-6">
          {data.webhooks.length === 0 ? (
            <EmptyWebhooks onCreate={() => setCreateOpen(true)} />
          ) : (
            <div className="space-y-3">
              {data.webhooks.map((hook) => (
                <WebhookCard
                  key={hook.id}
                  hook={hook}
                  events={data.available_events}
                  onChanged={load}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <PlanLockedCard
            feature="Webhooks"
            required={data.required_plan}
            current={data.plan.key}
          >
            <div className="grid gap-2.5 sm:grid-cols-3">
              {USE_CASES.map((useCase) => (
                <div key={useCase.title} className="rounded-md border border-border bg-card p-3">
                  <p className="text-[12px] font-medium text-foreground">{useCase.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {useCase.body}
                  </p>
                </div>
              ))}
            </div>
          </PlanLockedCard>
        </div>
      )}

      <CreateWebhookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        events={data.available_events}
        onDone={load}
      />
    </div>
  );
}

function EmptyWebhooks({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-md border border-border p-8 text-center">
      <WebhookIcon className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p className="mt-2 text-[14px] text-foreground">No webhooks yet</p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Add an endpoint to start receiving events.
      </p>
      <Button className="mt-3" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        New webhook
      </Button>
    </div>
  );
}

/** One webhook: header row, event chips, and its delivery history. */
function WebhookCard({
  hook,
  events,
  onChanged,
}: {
  hook: WebhookRow;
  events: string[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const toggleEnabled = async () => {
    setBusy(true);
    try {
      await apiSend(scoped(`/api/integrations/webhooks/${hook.id}`), "PATCH", {
        enabled: !hook.enabled,
      });
      toast.success(hook.enabled ? "Webhook paused" : "Webhook enabled");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">{hook.name}</span>
            <span
              className={cn(
                "rounded-[3px] border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em]",
                hook.enabled
                  ? "border-success-border bg-success-surface text-success"
                  : "border-border text-muted-foreground",
              )}
            >
              {hook.enabled ? "Active" : "Paused"}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[12px] text-muted-foreground">{hook.url}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hook.events.map((event) => (
              <span
                key={event}
                className="rounded-[3px] border border-border px-1.5 py-[2px] text-[11px] text-muted-foreground"
              >
                {eventLabel(event)}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleEnabled()}>
            {hook.enabled ? "Pause" : "Enable"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Button
            variant="bare"
            size="icon"
            aria-label={`Delete ${hook.name}`}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
          </Button>
        </div>
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        )}
        Delivery history ({hook.delivery_count})
      </button>
      {open ? (
        <div className="border-t border-border px-4 py-3">
          {hook.recent_deliveries.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No deliveries attempted yet.</p>
          ) : (
            <ul className="space-y-2">
              {hook.recent_deliveries.map((delivery) => {
                const ok =
                  delivery.status_code !== null &&
                  delivery.status_code >= 200 &&
                  delivery.status_code < 300;
                return (
                  <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                    {ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" strokeWidth={1.75} />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-danger" strokeWidth={1.75} />
                    )}
                    <span className="text-foreground">{eventLabel(delivery.event)}</span>
                    <span className="text-muted-foreground">
                      {delivery.status_code !== null ? `HTTP ${delivery.status_code}` : "No response"}
                    </span>
                    {delivery.duration_ms !== null ? (
                      <span className="text-subtle">{delivery.duration_ms} ms</span>
                    ) : null}
                    <span className="text-subtle">{timeLabel(delivery.attempted_at)}</span>
                    {delivery.error ? (
                      <span className="min-w-0 flex-1 truncate text-danger">{delivery.error}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      <WebhookFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        events={events}
        hook={hook}
        onDone={onChanged}
      />
      <DeleteWebhookDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        hook={hook}
        onDone={onChanged}
      />
    </div>
  );
}

/** Event checkbox list. At least one event is required by the API. */
function EventPicker({
  events,
  selected,
  onToggle,
}: {
  events: string[];
  selected: string[];
  onToggle: (event: string) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] text-muted-foreground">Events</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {events.map((event) => (
          <label
            key={event}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-2 text-[12px] text-foreground transition-colors duration-150 hover:bg-hover"
          >
            <input
              type="checkbox"
              checked={selected.includes(event)}
              onChange={() => onToggle(event)}
              className="h-3.5 w-3.5 accent-[hsl(var(--brand))]"
            />
            {eventLabel(event)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  events,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: string[];
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [shownSecret, setShownSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setUrl("");
    setSecret("");
    setSelected([]);
  }, [open]);

  const toggle = (event: string) =>
    setSelected((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );

  const valid = name.trim().length > 0 && url.trim().startsWith("https://") && selected.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      const result = await apiSend<{ secret_shown_once: string }>(
        scoped("/api/integrations/webhooks"),
        "POST",
        {
          name: name.trim(),
          url: url.trim(),
          events: selected,
          // Optional: blank means the server generates a strong secret.
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      );
      onOpenChange(false);
      setShownSecret(result.secret_shown_once);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>New webhook</DialogTitle>
              <DialogDescription>
                God Hosting POSTs a signed JSON body to your endpoint for each selected event.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="wh-name" className="text-[12px] text-muted-foreground">
                  Name
                </label>
                <Input
                  id="wh-name"
                  value={name}
                  autoFocus
                  maxLength={60}
                  placeholder="Slack deploys"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="wh-url" className="text-[12px] text-muted-foreground">
                  Endpoint URL
                </label>
                <Input
                  id="wh-url"
                  value={url}
                  placeholder="https://example.com/hooks/godhosting"
                  onChange={(e) => setUrl(e.target.value)}
                />
                {url && !url.trim().startsWith("https://") ? (
                  <p className="text-[11px] text-danger">The endpoint must be an https:// URL.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="wh-secret" className="text-[12px] text-muted-foreground">
                  Signing secret (optional)
                </label>
                <Input
                  id="wh-secret"
                  value={secret}
                  placeholder="Leave blank to generate one"
                  onChange={(e) => setSecret(e.target.value)}
                />
                <p className="text-[11px] text-subtle">
                  Minimum 16 characters. Shown once after saving and never retrievable again.
                </p>
              </div>
              <EventPicker events={events} selected={selected} onToggle={toggle} />
            </div>
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !valid}>
                {saving ? "Creating…" : "Create webhook"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SecretShownOnceDialog secret={shownSecret} onClose={() => setShownSecret(null)} />
    </>
  );
}

/** The one and only time the signing secret is visible. */
function SecretShownOnceDialog({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!secret}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save your signing secret</DialogTitle>
          <DialogDescription>
            Copy it now — this is the only time it is shown. Use it to verify the signature on every
            delivery.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 p-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-foreground">
            {secret}
          </code>
          <Button
            variant="bare"
            size="icon"
            aria-label="Copy signing secret"
            onClick={async () => {
              if (secret && (await copyToClipboard(secret))) toast.success("Secret copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            I saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit an existing webhook: name, endpoint and events. The secret is deliberately
 * absent — `PATCH` does not accept one, so rotating it means creating a new hook.
 */
function WebhookFormDialog({
  open,
  onOpenChange,
  events,
  hook,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: string[];
  hook: WebhookRow;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(hook.name);
  const [url, setUrl] = useState(hook.url);
  const [selected, setSelected] = useState<string[]>(hook.events);
  const [saving, setSaving] = useState(false);

  // Re-seed from the row each time the dialog opens so a cancelled edit is dropped.
  useEffect(() => {
    if (!open) return;
    setName(hook.name);
    setUrl(hook.url);
    setSelected(hook.events);
  }, [open, hook]);

  const toggle = (event: string) =>
    setSelected((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );

  const valid = name.trim().length > 0 && url.trim().startsWith("https://") && selected.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await apiSend(scoped(`/api/integrations/webhooks/${hook.id}`), "PATCH", {
        name: name.trim(),
        url: url.trim(),
        events: selected,
      });
      toast.success("Webhook updated");
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
      <DialogContent className="max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit webhook</DialogTitle>
            <DialogDescription>
              The signing secret stays as it is. Create a new webhook to rotate it.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={`wh-name-${hook.id}`} className="text-[12px] text-muted-foreground">
                Name
              </label>
              <Input
                id={`wh-name-${hook.id}`}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`wh-url-${hook.id}`} className="text-[12px] text-muted-foreground">
                Endpoint URL
              </label>
              <Input
                id={`wh-url-${hook.id}`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              {url && !url.trim().startsWith("https://") ? (
                <p className="text-[11px] text-danger">The endpoint must be an https:// URL.</p>
              ) : null}
            </div>
            <EventPicker events={events} selected={selected} onToggle={toggle} />
          </div>
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !valid}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Destructive, so it is confirmed (§77) and names the hook being removed. */
function DeleteWebhookDialog({
  open,
  onOpenChange,
  hook,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hook: WebhookRow;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await apiSend(scoped(`/api/integrations/webhooks/${hook.id}`), "DELETE");
      toast.success("Webhook deleted");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete webhook</DialogTitle>
          <DialogDescription>
            <span className="text-foreground">{hook.name}</span> stops receiving events
            immediately, and its delivery history is removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
