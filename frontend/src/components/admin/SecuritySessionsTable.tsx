// Live operator sessions (§30) — every bearer token the middleware will honour.
//
// Ending a row is not a list operation: `assertSessionLive` refuses that token on
// its next request, so the operator is out. Which is why the two rules the server
// enforces are on screen rather than implied by a hidden button:
//
//   • Ending *someone else's* session needs a super administrator. A
//     `security.manage` holder still sees the button, disabled with the reason —
//     "why can't I sign this person out" deserves an answer, not a missing control.
//   • "Sign out my other devices" spares the token this page was loaded with. That
//     is decided server-side, from the Authorization header, and only when the
//     target is the caller.
//
// The search box filters client-side on purpose: the endpoint returns at most 100
// sessions, so there is nothing to page through and a round trip per keypress
// would buy nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, LogOut, RefreshCw, ShieldAlert, UserX } from "lucide-react";
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
import {
  DetailRow,
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  SearchField,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { SessionRow, SessionsResponse } from "@/lib/adminSecurityTypes";
import { formatDateTime, humanize, isPast, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const SCOPES: PillOption[] = [
  { value: "live", label: "Live now" },
  { value: "all", label: "Including ended" },
];

interface Props {
  canManage: boolean;
  /** Owner/super_admin. The server refuses everyone else with 403, not this flag. */
  canRevokeOthers: boolean;
  /** Bumped by the page so the overview counters and this table stay in step. */
  onChanged: () => void;
}

/** Live / expired / ended, read off the row — the `all` scope mixes all three. */
function sessionState(row: SessionRow): { label: string; tone: "success" | "neutral" | "warning" } {
  if (row.revoked_at) return { label: "Ended", tone: "neutral" };
  if (isPast(row.expires_at)) return { label: "Expired", tone: "warning" };
  return { label: "Live", tone: "success" };
}

export function SecuritySessionsTable({ canManage, canRevokeOthers, onChanged }: Props) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("live");
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<SessionRow | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokingMine, setRevokingMine] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminGet<SessionsResponse>(`/sessions${scope === "all" ? "?ended=1" : ""}`);
      setRows(res.sessions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.email, r.name, r.ip, r.device, r.role].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const revoke = async (row: SessionRow) => {
    setRevoking(true);
    try {
      const res = await adminSend<{ message?: string }>(`/sessions/${row.id}`, "DELETE");
      setConfirming(null);
      toast.success(res.message || "Session ended.");
      // Ending your own session invalidates the token this page is holding, so
      // there is nothing left to refresh — go back to the sign-in screen rather
      // than let every later request fail with a 401 the operator has to decode.
      if (row.is_self) {
        window.location.assign("/admin/login");
        return;
      }
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The session was not ended.");
    } finally {
      setRevoking(false);
    }
  };

  const revokeMine = async () => {
    setRevokingMine(true);
    try {
      const res = await adminSend<{ message?: string; revoked?: number }>(
        "/sessions/revoke-all",
        "POST",
        {},
      );
      toast.success(res.message || "Your other sessions were signed out.");
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign the other sessions out.");
    } finally {
      setRevokingMine(false);
    }
  };

  /** Why the revoke button is disabled, in words, for the row's `title`. */
  const blockedReason = (row: SessionRow): string | null => {
    if (!canManage) return "Ending a session needs the security.manage permission.";
    if (row.revoked_at || isPast(row.expires_at)) return "This session has already ended.";
    if (!row.is_self && !canRevokeOthers) {
      return "Ending another operator's session needs a super administrator.";
    }
    return null;
  };

  const suspicious = rows.filter((r) => r.suspicious && !r.revoked_at).length;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search operator, IP or device…"
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilterPills options={SCOPES} value={scope} onChange={setScope} />
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={revokeMine}
              disabled={revokingMine}
              className="border-border/60"
              title="Ends every session of your own account except this one."
            >
              {revokingMine ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              Sign out my other devices
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-9 w-9 border-border/60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {suspicious > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">
              {suspicious} live session{suspicious === 1 ? "" : "s"} came from an address or device
              that account had not used before.
            </span>{" "}
            Worth a look, not an alarm — a new laptop or a changed ISP looks exactly the same from
            here.
          </span>
        </div>
      )}

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        <ListEmpty
          message={search ? "No session matches that search." : "No operator sessions are live."}
          hint={
            search
              ? "Clear the search to see them all."
              : "A row appears here the moment somebody with admin access signs in."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {filtered.map((row) => {
              const state = sessionState(row);
              const blocked = blockedReason(row);
              return (
                <article
                  key={row.id}
                  className={cn(
                    "rounded-2xl border bg-card p-4",
                    row.is_self ? "border-brand/30" : "border-border/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">
                        {row.email ?? row.user_id}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {row.name || "—"} · {humanize(row.role)}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <ToneBadge label={state.label} tone={state.tone} />
                      {row.is_self && <ToneBadge label="This device" tone="info" />}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <p className="truncate">
                      {row.device || "Unknown device"} · {row.ip || "no address"}
                    </p>
                    <p>
                      Last seen {relativeDays(row.last_seen_at)} · expires{" "}
                      {relativeDays(row.expires_at)}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {row.suspicious && <ToneBadge label="New device or IP" tone="warning" />}
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto border-danger-border text-danger hover:bg-danger-surface"
                      disabled={Boolean(blocked)}
                      title={blocked ?? undefined}
                      onClick={() => setConfirming(row)}
                    >
                      <UserX className="h-3.5 w-3.5" />
                      {row.is_self ? "Sign out" : "Revoke"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Operator</th>
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">IP</th>
                  <th className="px-4 py-3">Signed in</th>
                  <th className="px-4 py-3">Last seen</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filtered.map((row) => {
                  const state = sessionState(row);
                  const blocked = blockedReason(row);
                  return (
                    <tr
                      key={row.id}
                      className={cn("hover:bg-secondary/30", row.is_self && "bg-brand/5")}
                    >
                      <td className="max-w-[220px] px-4 py-3">
                        <span className="block truncate font-semibold">
                          {row.email ?? row.user_id}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {row.name || "—"} · {humanize(row.role)}
                          {row.is_self && <span className="text-brand"> · this device</span>}
                        </span>
                      </td>
                      <td className="max-w-[160px] px-4 py-3 text-muted-foreground">
                        <span className="block truncate" title={row.user_agent ?? undefined}>
                          {row.device || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {row.ip || "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {relativeDays(row.last_seen_at)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {relativeDays(row.expires_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ToneBadge label={state.label} tone={state.tone} />
                          {row.suspicious && (
                            <ToneBadge
                              label="New"
                              tone="warning"
                              title="Signed in from an address or device this account had not used before."
                            />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-danger-surface"
                          disabled={Boolean(blocked)}
                          title={blocked ?? undefined}
                          onClick={() => setConfirming(row)}
                        >
                          <UserX className="h-3.5 w-3.5" />
                          {row.is_self ? "Sign out" : "Revoke"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Showing <span className="font-semibold text-foreground">{filtered.length}</span> of{" "}
            {rows.length} session{rows.length === 1 ? "" : "s"}
            {scope === "live" ? " that are live now" : " recorded"}. Customer sign-ins are not
            listed — only accounts with admin access get a session row.
          </p>
        </>
      )}

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-surface">
                <UserX className="h-6 w-6 text-danger" />
              </div>
              <DialogTitle className="text-center">
                {confirming.is_self ? "Sign this device out?" : "End this session?"}
              </DialogTitle>
              <DialogDescription className="text-center">
                {confirming.is_self
                  ? "You are signing out the browser you are reading this in. You will be sent back to the sign-in page."
                  : "The token stops working on their next request — mid-form, mid-upload, without warning."}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-1">
              <DetailRow label="Operator">{confirming.email ?? confirming.user_id}</DetailRow>
              <DetailRow label="Role">{humanize(confirming.role)}</DetailRow>
              <DetailRow label="Device">{confirming.device || "Unknown"}</DetailRow>
              <DetailRow label="IP">
                <span className="font-mono text-xs">{confirming.ip || "—"}</span>
              </DetailRow>
              <DetailRow label="Signed in">{formatDateTime(confirming.created_at)}</DetailRow>
              <DetailRow label="Last seen">{formatDateTime(confirming.last_seen_at)}</DetailRow>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)} disabled={revoking}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => revoke(confirming)} disabled={revoking}>
                {revoking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UserX className="h-4 w-4" />
                )}
                {confirming.is_self ? "Sign out" : "End session"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

