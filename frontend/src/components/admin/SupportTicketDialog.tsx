// One support ticket: the thread, triage, and the reply box — §23.
//
// Two things this view has to get right or it is dangerous to use.
//
// First, an internal note must be unmistakable. The customer never sees one, so a
// note that *looks* like a reply is how a colleague's "this account keeps chargeback-
// ing us" ends up believed to have been sent. Notes are rendered on the same side as
// replies but amber, dashed, and labelled "Internal note — the customer cannot see
// this", and the composer changes colour and button text while the toggle is on.
//
// Second, a reply reports its own mail outcome. `POST …/messages` returns
// `mail: { status, message } | null` — `null` when nothing was mailed (a note, or no
// requester on file), `queued` when SMTP is not ready, `skipped` when the template is
// switched off. Each is surfaced differently; none of them says "sent".
//
// Triage PATCHes immediately rather than collecting changes behind a Save, because
// assigning a ticket to yourself is the sort of thing you do while reading it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Lock, MessageSquare, Send, Sparkles, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, ListError, ListSkeleton, SelectBox, ToneBadge } from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type {
  ReplyResult,
  SupportAgent,
  SupportMessage,
  SupportTicketDetail,
} from "@/lib/adminCommsTypes";
import { priorityTone, ticketTone } from "@/lib/adminCommsTypes";
import { formatDateTime, humanize } from "@/lib/adminFormat";
import { roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";

/** One message bubble. The `internal` case is deliberately loud. */
function Message({ m }: { m: SupportMessage }) {
  const fromCustomer = m.author === "user";
  const system = m.author === "system";

  if (system) {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3 shrink-0" />
        <span className="min-w-0 break-words">{m.body}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatDateTime(m.created_at)}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex", fromCustomer ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl border px-3.5 py-2.5",
          m.internal
            ? "border-dashed border-warning-border bg-warning-surface"
            : fromCustomer
              ? "border-border/60 bg-secondary/40"
              : "border-brand/20 bg-brand/5",
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          {m.internal ? (
            <Lock className="h-3 w-3 text-warning" />
          ) : fromCustomer ? (
            <UserIcon className="h-3 w-3" />
          ) : (
            <MessageSquare className="h-3 w-3" />
          )}
          <span className="truncate">
            {m.internal
              ? "Internal note — the customer cannot see this"
              : fromCustomer
                ? "Customer"
                : m.author_name || "Support"}
          </span>
        </div>
        <p className={cn("whitespace-pre-wrap text-sm", m.internal && "text-warning")}>{m.body}</p>
        <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
          {formatDateTime(m.created_at)}
        </p>
      </div>
    </div>
  );
}

export function SupportTicketDialog({
  ticketId,
  canManage,
  currentAdminId,
  onClose,
  onChanged,
}: {
  ticketId: string;
  canManage: boolean;
  /** Enables "Assign to me" without a second round trip. */
  currentAdminId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<SupportTicketDetail | null>(null);
  const [agents, setAgents] = useState<SupportAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [resolveWithReply, setResolveWithReply] = useState(false);
  const [sending, setSending] = useState(false);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminGet<SupportTicketDetail>(`/support/tickets/${ticketId}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that ticket");
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
    adminGet<{ agents: SupportAgent[] }>("/support/agents")
      .then((res) => setAgents(res.agents))
      // Not fatal: triage still works, the assignee select is just empty.
      .catch(() => setAgents([]));
  }, [load]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);

  const ticket = data?.ticket;

  /** One PATCH per control, applied at once. */
  const patch = async (body: Record<string, unknown>, note: string) => {
    setBusy(true);
    try {
      await adminSend(`/support/tickets/${ticketId}`, "PATCH", body);
      toast.success(note);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the ticket.");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    try {
      const res = await adminSend<ReplyResult>(`/support/tickets/${ticketId}/messages`, "POST", {
        body: text,
        internal,
        ...(resolveWithReply ? { status: "resolved" } : {}),
      });
      // Report the mail exactly as the server described it. `null` means nothing was
      // mailed at all, which for an internal note is the correct outcome.
      if (internal) toast.success("Note saved. The customer cannot see it.");
      else if (!res.mail) toast.warning("Reply saved, but there is no account to mail it to.");
      else if (res.mail.status === "sent") toast.success("Reply sent to the customer.");
      else if (res.mail.status === "queued") toast.warning(res.mail.message);
      else toast.error(res.mail.message);
      setReply("");
      setResolveWithReply(false);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The reply was not posted.");
    } finally {
      setSending(false);
    }
  };

  const assignedToMe = Boolean(
    currentAdminId && ticket?.assignee?.id && ticket.assignee.id === currentAdminId,
  );

  const waitingOnUs = useMemo(() => {
    const last = data?.messages.filter((m) => !m.internal).at(-1);
    return last?.author === "user";
  }, [data]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words pr-6">
            {ticket?.subject ?? "Ticket"}
          </DialogTitle>
          <DialogDescription>
            {ticket ? (
              <>
                <span className="font-mono text-[11px]">{ticket.id}</span> · opened{" "}
                {formatDateTime(ticket.created_at)}
                {ticket.requester ? ` by ${ticket.requester.email}` : ""}
              </>
            ) : (
              "Loading the thread…"
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <ListError message={error} onRetry={load} />}
        {!ticket && !error && <ListSkeleton rows={5} />}

        {ticket && data && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <ToneBadge label={humanize(ticket.status)} tone={ticketTone(ticket.status)} />
              <ToneBadge label={humanize(ticket.priority)} tone={priorityTone(ticket.priority)} />
              <ToneBadge label={humanize(ticket.category)} />
              {waitingOnUs && <ToneBadge label="Waiting on us" tone="warning" />}
              {ticket.workspace && (
                <ToneBadge
                  label={`${ticket.workspace.name}${ticket.workspace.plan_key ? ` · ${ticket.workspace.plan_key}` : ""}`}
                />
              )}
              {ticket.requester?.status && ticket.requester.status !== "active" && (
                <ToneBadge label={`Account ${ticket.requester.status}`} tone="danger" />
              )}
              {ticket.resolved_at && (
                <ToneBadge label={`Resolved ${formatDateTime(ticket.resolved_at)}`} tone="success" />
              )}
            </div>

            {canManage && (
              <div className="grid gap-3 rounded-2xl border border-border/60 bg-secondary/20 p-3 sm:grid-cols-4">
                <Field label="Status">
                  <SelectBox
                    value={ticket.status}
                    disabled={busy}
                    onChange={(v) => patch({ status: v }, `Moved to ${humanize(v).toLowerCase()}.`)}
                  >
                    {data.statuses.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </SelectBox>
                </Field>
                <Field label="Priority">
                  <SelectBox
                    value={ticket.priority}
                    disabled={busy}
                    onChange={(v) => patch({ priority: v }, `Priority set to ${humanize(v).toLowerCase()}.`)}
                  >
                    {data.priorities.map((p) => (
                      <option key={p} value={p}>
                        {humanize(p)}
                      </option>
                    ))}
                  </SelectBox>
                </Field>
                <Field label="Category">
                  <SelectBox
                    value={ticket.category}
                    disabled={busy}
                    onChange={(v) => patch({ category: v }, `Filed under ${humanize(v).toLowerCase()}.`)}
                  >
                    {data.categories.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </SelectBox>
                </Field>
                <Field
                  label="Assignee"
                  hint={
                    !assignedToMe && currentAdminId
                      ? undefined
                      : ticket.assignee
                        ? "Yours"
                        : "Nobody is on this"
                  }
                >
                  <SelectBox
                    value={ticket.assignee?.id ?? ""}
                    disabled={busy}
                    onChange={(v) =>
                      patch(
                        { assignee_id: v },
                        v ? "Assigned." : "Unassigned — it is back in the queue.",
                      )
                    }
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name || a.email} — {roleLabel(a.role)}
                      </option>
                    ))}
                  </SelectBox>
                </Field>
                {currentAdminId && !assignedToMe && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => patch({ assignee_id: currentAdminId }, "Assigned to you.")}
                    className="sm:col-span-4 sm:justify-self-start"
                  >
                    Assign to me
                  </Button>
                )}
              </div>
            )}

            <div className="space-y-3">
              {data.messages.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  No messages on this ticket.
                </p>
              ) : (
                data.messages.map((m) => <Message key={m.id} m={m} />)
              )}
              <div ref={threadEnd} />
            </div>
          </div>
        )}

        {ticket && canManage && (
          <div
            className={cn(
              "mt-2 shrink-0 space-y-2 rounded-2xl border p-3",
              internal ? "border-warning-border bg-warning-surface/40" : "border-border/60 bg-card",
            )}
          >
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              placeholder={
                internal
                  ? "A note for other operators. Never shown to the customer, never emailed."
                  : "Your reply. This is emailed to the customer using the “Support reply” template."
              }
              className={cn(internal && "border-warning-border")}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                    className="h-4 w-4 accent-[hsl(var(--brand))]"
                  />
                  Internal note
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={resolveWithReply}
                    onChange={(e) => setResolveWithReply(e.target.checked)}
                    className="h-4 w-4 accent-[hsl(var(--brand))]"
                  />
                  Mark resolved
                </label>
              </div>
              <Button
                onClick={send}
                disabled={sending || !reply.trim()}
                variant={internal ? "warning" : "default"}
                className="shrink-0"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : internal ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {internal ? "Save note" : "Send reply"}
              </Button>
            </div>
          </div>
        )}

        {ticket && !canManage && (
          <p className="shrink-0 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
            Read-only — `support.manage` is required to reply or change a ticket.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
