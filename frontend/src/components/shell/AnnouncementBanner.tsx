// Platform announcements, as the customer sees them (§22).
//
// The admin panel can compose a notice, publish it and deliver it; without this
// component the `banner` and `modal` placements would be a promise the product never
// keeps — an operator would publish an outage notice and nobody's dashboard would
// change. `GET /api/notifications/announcements` is the whole contract, and it is
// deliberately thin: the server decides who is in the audience and whether a notice
// is inside its window (`lib/announcements.ts`), so this file has no opinion about
// either. Anything it receives, it shows.
//
// Dismissal is per-id in localStorage rather than a database column. A read receipt
// would be a fourth thing to keep consistent for a strictly cosmetic benefit, and the
// inbox notice written by Deliver is already the durable record that someone was
// told. The consequence is honest and small: dismiss on a laptop, see it once more on
// a phone.
//
// A failed fetch is swallowed. An announcements endpoint having a bad day must not
// take the shell down with it.

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Megaphone, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiGet } from "@/lib/workspaceApi";
import { cn } from "@/lib/utils";
import type { IconComponent } from "./navigation";

interface LiveAnnouncement {
  id: string;
  title: string;
  body: string;
  level: string;
  placement: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

const SEEN_KEY = "docklift_announcements_seen";
/** Enough history that a dismissed notice stays dismissed; bounded so it cannot grow. */
const SEEN_CAP = 200;
const POLL_MS = 5 * 60 * 1000;

function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return []; // Private mode / storage disabled: every notice simply shows again.
  }
}

function writeSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-SEEN_CAP)));
  } catch {
    /* Non-fatal. */
  }
}

const LEVELS: Record<string, { strip: string; text: string; icon: IconComponent }> = {
  critical: {
    strip: "border-danger-border bg-danger-surface",
    text: "text-danger",
    icon: TriangleAlert,
  },
  warning: {
    strip: "border-warning-border bg-warning-surface",
    text: "text-warning",
    icon: TriangleAlert,
  },
  success: {
    strip: "border-success-border bg-success-surface",
    text: "text-success",
    icon: CheckCircle2,
  },
  info: { strip: "border-brand/20 bg-brand/5", text: "text-brand", icon: Megaphone },
};

function levelStyle(level: string) {
  return LEVELS[level] ?? LEVELS.info;
}

/** Loudest first, then newest. Two criticals are ordered by recency, not by id. */
const SEVERITY: Record<string, number> = { critical: 3, warning: 2, success: 1, info: 0 };

/** At most this many strips at once — a wall of banners is not an announcement. */
const MAX_BANNERS = 2;

export function AnnouncementBanner() {
  const [items, setItems] = useState<LiveAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(() => readSeen());

  useEffect(() => {
    let alive = true;
    const load = () => {
      apiGet<{ announcements: LiveAnnouncement[] }>("/api/notifications/announcements")
        .then((res) => {
          if (alive) setItems(Array.isArray(res.announcements) ? res.announcements : []);
        })
        // Silent on purpose: a notice that cannot be fetched is not an error the
        // customer can act on, and the shell has to keep working regardless.
        .catch(() => {});
    };
    load();
    // A notice published mid-session should appear without a reload — an outage
    // banner nobody sees until they navigate is most of the way to useless.
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      writeSeen(next);
      return next;
    });
  };

  const { banners, modal } = useMemo(() => {
    const live = items
      .filter((a) => !dismissed.includes(a.id))
      .sort(
        (a, b) =>
          (SEVERITY[b.level] ?? 0) - (SEVERITY[a.level] ?? 0) ||
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    return {
      banners: live.filter((a) => a.placement === "banner").slice(0, MAX_BANNERS),
      modal: live.find((a) => a.placement === "modal") ?? null,
    };
  }, [items, dismissed]);

  if (banners.length === 0 && !modal) return null;

  return (
    <>
      {banners.map((a) => {
        const style = levelStyle(a.level);
        const Icon = style.icon;
        return (
          <div
            key={a.id}
            className={cn(
              "flex items-start gap-x-3 gap-y-1 border-b px-4 py-2.5 text-[12px] sm:px-6 lg:px-8",
              style.strip,
            )}
          >
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", style.text)} strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <span className={cn("font-semibold", style.text)}>{a.title}</span>
              {/* Blank lines are meaningful — the editor writes paragraphs. */}
              <p className="mt-0.5 whitespace-pre-line break-words text-muted-foreground">
                {a.body}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              title="Dismiss"
              aria-label={`Dismiss: ${a.title}`}
              className="press -mr-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {modal && (
        <Dialog open onOpenChange={(o) => !o && dismiss(modal.id)}>
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex min-w-0 items-start gap-2 break-words pr-6">
                {(() => {
                  const Icon = levelStyle(modal.level).icon;
                  return (
                    <Icon
                      className={cn("mt-0.5 h-4 w-4 shrink-0", levelStyle(modal.level).text)}
                      strokeWidth={2}
                    />
                  );
                })()}
                {modal.title}
              </DialogTitle>
              {modal.ends_at && (
                <DialogDescription>
                  Shown until {new Date(modal.ends_at).toLocaleString()}.
                </DialogDescription>
              )}
            </DialogHeader>

            <p className="whitespace-pre-line break-words text-sm leading-relaxed">{modal.body}</p>

            <DialogFooter>
              <Button onClick={() => dismiss(modal.id)}>Got it</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

