// Create / edit an announcement — §22.
//
// The two fields that decide who is disturbed are `audience` and `placement`, so they
// are next to each other and both say what they mean in prose. A `modal` announcement
// to `all` interrupts every signed-in customer; that should be a deliberate choice,
// not the default a form fell into.
//
// Validation mirrors `validateAnnouncement()` on the server field for field — the
// button is disabled for the same reasons the API would 400, so the operator is told
// before the round trip rather than after it. The server still validates; this only
// saves a wasted request.
//
// `published` is not delivery. Publishing makes the banner/modal eligible to appear;
// the inbox copy and the mail are written by `POST /:id/deliver`, which is a separate,
// explicit act with its own confirmation. That split is why nothing here promises
// anyone was told.

import { useMemo, useState } from "react";
import { Loader2, Save, X } from "lucide-react";
import { toast } from "sonner";
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
import { Field, SelectBox } from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { Announcement, PlanFacet } from "@/lib/adminCommsTypes";
import type { AdminUsersResponse } from "@/lib/adminTypes";
import { humanize } from "@/lib/adminFormat";
import { roleLabel } from "@/lib/roles";
import { cn } from "@/lib/utils";

/** Roles an announcement can be addressed to. Matches `resolveAudience`'s `role` arm. */
const ROLE_REFS = [
  "user",
  "viewer",
  "support_admin",
  "billing_admin",
  "operations_admin",
  "admin",
  "super_admin",
  "owner",
];

const PLACEMENT_COPY: Record<string, string> = {
  banner: "A strip across the top of the app until it is dismissed or expires.",
  modal: "Interrupts with a dialog on the next page load. Use sparingly.",
  inbox: "Only in the notification feed — the quietest option.",
};

const AUDIENCE_COPY: Record<string, string> = {
  all: "Every active account.",
  plan: "Accounts on the plans you pick.",
  role: "Accounts holding the roles you pick.",
  user: "Only the accounts you name.",
};

/** ISO → the `datetime-local` value, in the operator's own timezone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface Draft {
  title: string;
  body: string;
  level: string;
  audience: string;
  audience_ref: string[];
  placement: string;
  published: boolean;
  send_email: boolean;
  starts_at: string;
  ends_at: string;
}

function toDraft(a: Announcement | null): Draft {
  return {
    title: a?.title ?? "",
    body: a?.body ?? "",
    level: a?.level ?? "info",
    audience: a?.audience ?? "all",
    audience_ref: a?.audience_ref ?? [],
    placement: a?.placement ?? "inbox",
    published: a?.published ?? false,
    send_email: a?.send_email ?? false,
    starts_at: toLocalInput(a?.starts_at),
    ends_at: toLocalInput(a?.ends_at),
  };
}

/** Searchable account picker for the `user` audience. Chips carry the email. */
function UserPicker({
  selected,
  labels,
  onChange,
  onLabel,
}: {
  selected: string[];
  labels: Record<string, string>;
  onChange: (ids: string[]) => void;
  onLabel: (id: string, label: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AdminUsersResponse["users"]>([]);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    try {
      const res = await adminGet<AdminUsersResponse>(
        `/users?q=${encodeURIComponent(term)}&page=1&pageSize=8`,
      );
      setResults(res.users);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not search accounts.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="Search by name or email, then press Enter"
        />
        <Button variant="outline" onClick={search} disabled={searching || !q.trim()}>
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
        </Button>
      </div>

      {results.length > 0 && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border/60 p-1.5">
          {results.map((u) => {
            const on = selected.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  onLabel(u.id, u.email);
                  onChange(on ? selected.filter((id) => id !== u.id) : [...selected, u.id]);
                }}
                className={cn(
                  "press flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs",
                  on ? "bg-brand/10 text-brand" : "hover:bg-secondary/60",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{u.name || u.email}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{u.email}</span>
                </span>
                <span className="shrink-0 text-[11px]">{on ? "Remove" : "Add"}</span>
              </button>
            );
          })}
        </div>
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-2.5 py-1 text-[11px]"
            >
              <span className="truncate">{labels[id] ?? id}</span>
              <button
                type="button"
                onClick={() => onChange(selected.filter((x) => x !== id))}
                aria-label="Remove"
                className="shrink-0 text-muted-foreground hover:text-danger"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Multi-select as toggle chips — used for both the plan and the role audiences. */
function RefChips({
  options,
  selected,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
            className={cn(
              "press rounded-xl border px-3 py-1.5 text-xs font-medium",
              on
                ? "border-brand/30 bg-brand/10 text-brand"
                : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function AnnouncementEditorDialog({
  announcement,
  levels,
  audiences,
  placements,
  plans,
  onClose,
  onSaved,
}: {
  /** null ⇒ compose a new one. */
  announcement: Announcement | null;
  levels: readonly string[];
  audiences: readonly string[];
  placements: readonly string[];
  plans: PlanFacet[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(announcement));
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  // Same rules as `validateAnnouncement()` on the server, in the same order.
  const problem = useMemo(() => {
    if (!draft.title.trim()) return "An announcement needs a title.";
    if (!draft.body.trim()) return "An announcement needs a body.";
    if (draft.audience !== "all" && draft.audience_ref.length === 0)
      return `An audience of "${draft.audience}" needs at least one selection.`;
    if (draft.starts_at && draft.ends_at && new Date(draft.ends_at) <= new Date(draft.starts_at))
      return "It cannot end before it starts.";
    return null;
  }, [draft]);

  const save = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const body = {
        title: draft.title.trim(),
        body: draft.body.trim(),
        level: draft.level,
        audience: draft.audience,
        audience_ref: draft.audience === "all" ? [] : draft.audience_ref,
        placement: draft.placement,
        published: draft.published,
        send_email: draft.send_email,
        starts_at: fromLocalInput(draft.starts_at),
        ends_at: fromLocalInput(draft.ends_at),
      };
      if (announcement) await adminSend(`/announcements/${announcement.id}`, "PATCH", body);
      else await adminSend("/announcements", "POST", body);
      toast.success(announcement ? "Announcement saved." : "Announcement created.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The announcement was not saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{announcement ? "Edit announcement" : "New announcement"}</DialogTitle>
          <DialogDescription>
            Publishing makes it eligible to appear. Sending it to inboxes and by email is a
            separate step — <strong>Deliver</strong> on the row.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Title">
            <Input
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Scheduled maintenance on Sunday"
              maxLength={200}
            />
          </Field>

          <Field
            label="Body"
            hint="Plain text. Blank lines become paragraphs in the email; the banner shows the first part."
          >
            <Textarea
              value={draft.body}
              onChange={(e) => set("body", e.target.value)}
              rows={6}
              placeholder="What is happening, when, and what the customer should do."
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Level" hint="Decides the colour and the notification severity.">
              <SelectBox value={draft.level} onChange={(v) => set("level", v)}>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {humanize(l)}
                  </option>
                ))}
              </SelectBox>
            </Field>
            <Field label="Placement" hint={PLACEMENT_COPY[draft.placement]}>
              <SelectBox value={draft.placement} onChange={(v) => set("placement", v)}>
                {placements.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </SelectBox>
            </Field>
          </div>

          <Field label="Audience" hint={AUDIENCE_COPY[draft.audience]}>
            <SelectBox
              value={draft.audience}
              onChange={(v) => {
                set("audience", v);
                set("audience_ref", []);
              }}
            >
              {audiences.map((a) => (
                <option key={a} value={a}>
                  {a === "all" ? "Everyone" : humanize(a)}
                </option>
              ))}
            </SelectBox>
          </Field>

          {draft.audience === "plan" && (
            <Field label="Plans" hint="Matched on the plan key, so a rename does not break it.">
              {plans.length === 0 ? (
                <p className="text-xs text-muted-foreground">No plans are defined yet.</p>
              ) : (
                <RefChips
                  options={plans.map((p) => ({ value: p.key, label: p.name }))}
                  selected={draft.audience_ref}
                  onChange={(next) => set("audience_ref", next)}
                />
              )}
            </Field>
          )}

          {draft.audience === "role" && (
            <Field label="Roles">
              <RefChips
                options={ROLE_REFS.map((r) => ({ value: r, label: roleLabel(r) }))}
                selected={draft.audience_ref}
                onChange={(next) => set("audience_ref", next)}
              />
            </Field>
          )}

          {draft.audience === "user" && (
            <Field label="Accounts" hint="Named accounts are included even if suspended.">
              <UserPicker
                selected={draft.audience_ref}
                labels={labels}
                onChange={(ids) => set("audience_ref", ids)}
                onLabel={(id, label) => setLabels((prev) => ({ ...prev, [id]: label }))}
              />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" hint="Blank means immediately.">
              <Input
                type="datetime-local"
                value={draft.starts_at}
                onChange={(e) => set("starts_at", e.target.value)}
              />
            </Field>
            <Field label="Ends" hint="Blank means it stays until unpublished.">
              <Input
                type="datetime-local"
                value={draft.ends_at}
                onChange={(e) => set("ends_at", e.target.value)}
              />
            </Field>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={draft.published}
              onChange={(e) => set("published", e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
            />
            <span className="text-xs">
              <span className="block font-semibold text-foreground">Published</span>
              <span className="block text-muted-foreground">
                Banners and modals only appear once this is on and the window is open. It does not
                notify anyone by itself.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={draft.send_email}
              onChange={(e) => set("send_email", e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
            />
            <span className="text-xs">
              <span className="block font-semibold text-foreground">Also send it by email</span>
              <span className="block text-muted-foreground">
                One mail per recipient when you press Deliver, using the “Announcement” template.
                Queued if SMTP is not ready.
              </span>
            </span>
          </label>

          {problem && (
            <div className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2.5 text-xs text-danger">
              {problem}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || Boolean(problem)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {announcement ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
