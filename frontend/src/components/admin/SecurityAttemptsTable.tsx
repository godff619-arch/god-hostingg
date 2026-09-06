// The sign-in attempt log (§29) — every attempt, successful or not, for every
// account, not just operators.
//
// This is the one table where the interesting rows are the ones nobody chose to
// make: a run of `No such account` against `admin@` is somebody guessing, and a
// run of `Wrong password` against a real address is either an attack or a locked-out
// colleague. Both look like noise until they are listed next to each other, which
// is why the filter offers the outcomes by name rather than a single "failed" pill.
//
// Server-paged, unlike the sessions table: this one grows forever, so `q` and the
// outcome filter are query parameters and `page_size` comes back with the rows.

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import {
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Pagination,
  SearchField,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/adminApi";
import type { AttemptsResponse, LoginAttemptRow } from "@/lib/adminSecurityTypes";
import { outcomeLabel, outcomeTone } from "@/lib/adminSecurityTypes";
import { formatDateTime } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** `Mozilla/5.0 (Windows NT 10.0…` is unreadable in a cell; the family is not. */
function shortAgent(ua: string | null | undefined): string {
  if (!ua) return "—";
  const m = ua.match(/(Edg|OPR|Chrome|Firefox|Safari|curl|PostmanRuntime|python-requests)/i);
  return m ? m[1].replace(/^Edg$/i, "Edge").replace(/^OPR$/i, "Opera") : ua.slice(0, 24);
}

export function SecurityAttemptsTable({ reloadKey = 0 }: { reloadKey?: number }) {
  const [rows, setRows] = useState<LoginAttemptRow[]>([]);
  const [data, setData] = useState<AttemptsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, outcome]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set("q", query);
      if (outcome !== "all") params.set("outcome", outcome);
      const res = await adminGet<AttemptsResponse>(`/security/attempts?${params.toString()}`);
      setRows(res.attempts);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sign-in attempts");
    } finally {
      setLoading(false);
    }
  }, [page, query, outcome]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // The outcomes come from the server so the filter can never offer a value the
  // backend would ignore. "Anything that failed" is ours, and it is the one an
  // operator reaches for first.
  const options = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "All attempts" },
      { value: "failed", label: "Anything that failed" },
      ...(data?.outcomes ?? []).map((o) => ({ value: o, label: outcomeLabel(o) })),
    ],
    [data?.outcomes],
  );

  return (
    <>
      <div className="mb-4 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search email address or IP…"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-11 w-11 shrink-0 border-border/60"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        </div>
        <FilterPills options={options} value={outcome} onChange={setOutcome} />
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message={
            query || outcome !== "all"
              ? "No attempt matches these filters."
              : "No sign-in attempt has been recorded yet."
          }
          hint={
            query || outcome !== "all"
              ? "Clear the search or pick another outcome."
              : "Every attempt from now on is logged here — the successful ones too."
          }
        />
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-semibold">{row.email}</span>
                  <ToneBadge label={outcomeLabel(row.outcome)} tone={outcomeTone(row.outcome)} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  <span className="font-mono">{row.ip || "no address"}</span> ·{" "}
                  {shortAgent(row.user_agent)} · {formatDateTime(row.created_at)}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Email tried</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3">IP</th>
                  <th className="px-4 py-3">Client</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-secondary/30">
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDateTime(row.created_at)}
                    </td>
                    <td className="max-w-[240px] px-4 py-3">
                      <span className="block truncate font-medium">{row.email}</span>
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={outcomeLabel(row.outcome)} tone={outcomeTone(row.outcome)} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {row.ip || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={row.user_agent ?? ""}>
                      {shortAgent(row.user_agent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={data?.page ?? page}
            pageSize={data?.page_size ?? rows.length}
            total={data?.total ?? rows.length}
            noun="attempts"
            onPage={setPage}
          />
        </>
      )}

      <p className="mt-4 flex items-start justify-center gap-2 text-center text-xs text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Passwords are never recorded — only the address that was tried and what the server
        answered. “No such account” means the email does not exist here, which is worth
        distinguishing from a wrong password when reading a burst.
      </p>
    </>
  );
}

