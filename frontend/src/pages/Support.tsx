// Support (/support) — the customer's half of the operator inbox (§23).
//
// The admin panel's Support page is only worth having if the person with the problem
// can open the ticket. This is that door: the caller's own threads, a composer and a
// reply box. Scoping is the server's job — `routes/support.ts` puts `user_id` in
// every where clause, so another account's ticket id is a 404 rather than a leak, and
// this page never has to reason about ownership.
//
// Two rules carried from the API rather than re-invented here:
//
//   • Internal notes are filtered out in the *query*, not the response mapper, so a
//     thread on this page physically cannot contain one. Nothing here hides anything.
//   • An account may hold `open_cap` open tickets at once. The cap is stated next to
//     the button before it refuses — learning the rule from a 429 is worse.
//
// Replying to a resolved ticket reopens it. The server decides that and reports it in
// `reopened`, which is why the reply box stays available on a resolved thread instead
// of forcing a second ticket that loses the history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Inbox,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend, errorMessage, scoped } from "@/lib/workspaceApi";
import { formatDateTime, humanize, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring";

/** Statuses the server counts against `open_cap`. */
const OPEN_STATUSES = ["open", "pending", "in_progress"];

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  message_count: number;
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
}

interface TicketsResponse {
  tickets: TicketRow[];
  priorities: string[];
  categories: string[];
  open_cap: number;
}

interface ThreadMessage {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

interface TicketDetail {
  ticket: Omit<TicketRow, "message_count">;
  messages: ThreadMessage[];
}

const TICKET_TONES: Record<string, string> = {
  open: "border-warning-border bg-warning-surface text-warning",
  in_progress: "border-brand/20 bg-brand/10 text-brand",
  pending: "border-border/60 bg-secondary text-muted-foreground",
  resolved: "border-success-border bg-success-surface text-success",
  closed: "border-border/60 bg-secondary text-muted-foreground",
};

const PRIORITY_TONES: Record<string, string> = {
  urgent: "border-danger-border bg-danger-surface text-danger",
  high: "border-warning-border bg-warning-surface text-warning",
  normal: "border-brand/20 bg-brand/10 text-brand",
  low: "border-border/60 bg-secondary text-muted-foreground",
};

/** The one badge this page needs, in the same token families as the rest of the app. */
function Pill({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        className ?? "border-border/60 bg-secondary text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export default function Support() {
  const [data, setData] = useState<TicketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiGet<TicketsResponse>("/api/support/tickets"));
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

  const tickets = data?.tickets ?? [];
  const cap = data?.open_cap ?? 10;
  const openCount = tickets.filter((t) => OPEN_STATUSES.includes(t.status)).length;
  const atCap = openCount >= cap;
  const settled = tickets.filter((t) => t.status === "resolved" || t.status === "closed").length;

  return (
    <>
      <PageHeader
        title="Support"
        eyebrow="Help"
        icon={LifeBuoy}
        description="Open a ticket and our operators answer here and by email. Anything about billing, a deploy, a domain or your account belongs on this page."
        meta={
          <>
            <StatChip label="Open" value={openCount} tone={openCount > 0 ? "warning" : "neutral"} />
            <StatChip label="Answered" value={settled} tone={settled > 0 ? "success" : "neutral"} />
            <StatChip label="Open at once" value={cap} />
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw
                className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")}
              />
            </Button>
            <Button
              onClick={() => setComposing(true)}
              disabled={atCap}
              title={
                atCap
                  ? `You already have ${openCount} open tickets. Reply on one of those instead.`
                  : undefined
              }
            >
              <Plus className="h-4 w-4" /> New ticket
            </Button>
          </>
        }
      />

      {atCap && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-xs text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span className="font-semibold">
            You have {openCount} open tickets, the most one account may hold.
          </span>
          <span className="text-muted-foreground">
            Reply on an existing thread and it moves back to the top of the queue.
          </span>
        </div>
      )}

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3">
          <span className="text-xs font-medium text-danger">{error}</span>
          <Button variant="outline" size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      )}

      {loading && tickets.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[92px] animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
            />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-6 py-14 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-secondary/50">
            <Inbox className="h-5 w-5 text-muted-foreground" />
          </span>
          <p className="text-sm font-semibold">No tickets yet.</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
            Open one and it lands in the operators' inbox straight away. Include the project or
            service name and what you expected to happen — that is usually the difference between
            one reply and four.
          </p>
          {!atCap && (
            <Button className="mt-6" onClick={() => setComposing(true)}>
              <Plus className="h-4 w-4" /> New ticket
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setOpenId(t.id)}
              className="press block w-full rounded-2xl border border-border/60 bg-card p-4 text-left transition-colors hover:bg-secondary/30 sm:p-5"
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <Pill label={humanize(t.status)} className={TICKET_TONES[t.status]} />
                <Pill label={humanize(t.priority)} className={PRIORITY_TONES[t.priority]} />
                <Pill label={humanize(t.category)} />
              </span>
              <span className="mt-2 block truncate text-sm font-semibold">{t.subject}</span>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                <span className="font-mono">{t.id}</span> · {t.message_count} message
                {t.message_count === 1 ? "" : "s"} · last activity{" "}
                {relativeDays(t.updated_at ?? t.created_at)}
              </span>
            </button>
          ))}
        </div>
      )}

      {composing && data && (
        <NewTicketDialog
          categories={data.categories}
          priorities={data.priorities}
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            void load();
            setOpenId(id);
          }}
        />
      )}

      {openId && (
        <TicketThreadDialog ticketId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </>
  );
}

/**
 * Compose one. Validation mirrors `routes/support.ts` field for field — a subject,
 * and a body of at least ten characters — so the dialog refuses for exactly the
 * reasons a 400 would, without the round trip.
 *
 * The POST is workspace-scoped so the ticket records *which* account's resources the
 * problem is about; support reads that on the other side.
 */
function NewTicketDialog({
  categories,
  priorities,
  onClose,
  onCreated,
}: {
  categories: string[];
  priorities: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // `other` rather than the first category: silently filing everything under
  // Billing because it happens to be first is worse than asking.
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState(priorities.includes("normal") ? "normal" : "low");
  const [saving, setSaving] = useState(false);

  const problem = useMemo(() => {
    if (!subject.trim()) return "Give the ticket a subject.";
    if (body.trim().length < 10)
      return "Describe the problem — at least a sentence, so support can act on it.";
    return null;
  }, [subject, body]);

  const submit = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const res = await apiSend<{ ticket: { id: string }; message: string }>(
        scoped("/api/support/tickets"),
        "POST",
        { subject: subject.trim(), body: body.trim(), category, priority },
      );
      toast.success(res.message);
      onCreated(res.ticket.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New support ticket</DialogTitle>
          <DialogDescription>
            An operator is notified as soon as you send this. Replies arrive here and, if your
            account has an email address on file, by email.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold">Subject</span>
            <Input
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Deploy fails on the api service"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold">What is it about?</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={SELECT_CLASS}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold">How urgent is it?</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={SELECT_CLASS}
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-muted-foreground">
                Support can raise this further once they have read it.
              </span>
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold">What happened?</span>
            <Textarea
              value={body}
              rows={7}
              maxLength={20_000}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                "Name the project or service, what you did, and what you expected instead.\n\nPaste any error exactly as it appeared — the wording is usually the fastest way to the cause."
              }
            />
            <span className="block text-[11px] text-muted-foreground">
              {body.trim().length} characters. Nobody but you and the operators can read this.
            </span>
          </label>

          {problem && (
            <p className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2 text-xs font-medium text-danger">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || Boolean(problem)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Open ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One bubble. `system` rows are the ticket's own history, not anybody's message. */
function Bubble({ m }: { m: ThreadMessage }) {
  const mine = m.author === "user";

  if (m.author === "system") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3 shrink-0" />
        <span className="min-w-0 break-words">{m.body}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatDateTime(m.created_at)}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl border px-3.5 py-2.5",
          mine ? "border-brand/20 bg-brand/5" : "border-border/60 bg-secondary/40",
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          {mine ? <UserIcon className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
          <span>{mine ? "You" : "Support"}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm">{m.body}</p>
        <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
          {formatDateTime(m.created_at)}
        </p>
      </div>
    </div>
  );
}

/**
 * One thread. The reply box stays available on a resolved ticket because replying is
 * how you say "still broken" — the server reopens it and tells us so in `reopened`,
 * and only refuses once the ticket has been closed for a fortnight.
 */
function TicketThreadDialog({
  ticketId,
  onClose,
  onChanged,
}: {
  ticketId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<TicketDetail>(`/api/support/tickets/${ticketId}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);

  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    try {
      const res = await apiSend<{ reopened: boolean }>(
        `/api/support/tickets/${ticketId}/messages`,
        "POST",
        { body: text },
      );
      toast.success(res.reopened ? "Sent — the ticket is open again." : "Reply sent.");
      setReply("");
      await load();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const ticket = data?.ticket;
  const settled = ticket?.status === "resolved" || ticket?.status === "closed";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words pr-6">
            {ticket?.subject ?? "Ticket"}
          </DialogTitle>
          <DialogDescription>
            {ticket ? (
              <>
                <span className="font-mono text-[11px]">{ticket.id}</span> · opened{" "}
                {formatDateTime(ticket.created_at)}
              </>
            ) : (
              "Loading the thread…"
            )}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-border bg-danger-surface px-3 py-2.5">
            <span className="text-xs font-medium text-danger">{error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        )}

        {!ticket && !error && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-2xl border border-border/60 bg-secondary/40"
              />
            ))}
          </div>
        )}

        {ticket && data && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill label={humanize(ticket.status)} className={TICKET_TONES[ticket.status]} />
              <Pill label={humanize(ticket.priority)} className={PRIORITY_TONES[ticket.priority]} />
              <Pill label={humanize(ticket.category)} />
            </div>

            {settled && (
              <p className="rounded-xl border border-success-border bg-success-surface px-3 py-2.5 text-xs text-success">
                {ticket.resolved_at
                  ? `Marked ${humanize(ticket.status).toLowerCase()} ${formatDateTime(ticket.resolved_at)}.`
                  : `Marked ${humanize(ticket.status).toLowerCase()}.`}{" "}
                <span className="text-muted-foreground">
                  If it is still not right, reply below — the ticket reopens with its history
                  intact.
                </span>
              </p>
            )}

            <div className="space-y-3">
              {data.messages.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing on this thread yet.
                </p>
              ) : (
                data.messages.map((m) => <Bubble key={m.id} m={m} />)
              )}
              <div ref={threadEnd} />
            </div>
          </div>
        )}

        {ticket && (
          <div className="mt-2 shrink-0 space-y-2 rounded-2xl border border-border/60 bg-card p-3">
            <Textarea
              value={reply}
              rows={3}
              maxLength={20_000}
              onChange={(e) => setReply(e.target.value)}
              placeholder={
                settled ? "Reply and this ticket reopens." : "Add anything that has changed since."
              }
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                Support is notified as soon as you send.
              </span>
              <Button onClick={send} disabled={sending || !reply.trim()} className="shrink-0">
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}


