// Admin Support (/admin/support) — §23.
//
// The default filter is not "all". It is "unresolved", because an inbox that opens on
// a thousand closed tickets is not an inbox — and `unassigned` is a first-class metric
// for the same reason: an unassigned open ticket is the one thing on this page that is
// definitely nobody's job yet.
//
// Sorted by last activity, server-side, so a customer's follow-up pulls their ticket
// back to the top instead of leaving it buried by creation date.
//
// The counts in the pills come from the API's facets over the whole table, so a filter
// never claims rows it cannot show (§53).

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LifeBuoy, RefreshCw, UserX } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Field,
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Metric,
  MetricStrip,
  Pagination,
  SearchField,
  SelectBox,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { SupportTicketDialog } from "@/components/admin/SupportTicketDialog";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet } from "@/lib/adminApi";
import type { SupportAgent, SupportTicketRow, SupportTicketsResponse } from "@/lib/adminCommsTypes";
import { priorityTone, ticketTone } from "@/lib/adminCommsTypes";
import { formatDateTime, humanize, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function AdminSupport() {
  const { me, can } = useAdminMe();
  const canManage = can("support.manage");
  // `/admin/support/:ticketId` is the URL every "new support ticket" notification
  // points at. Reaching this page by that link has to open the thread; landing on
  // the inbox and hunting for the id is what the link exists to avoid.
  const { ticketId } = useParams<{ ticketId?: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<SupportTicketsResponse | null>(null);
  const [rows, setRows] = useState<SupportTicketRow[]>([]);
  const [agents, setAgents] = useState<SupportAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // Opens on what needs attention, not on the archive.
  const [status, setStatus] = useState("unresolved");
  const [priority, setPriority] = useState("all");
  const [category, setCategory] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(ticketId ?? null);

  // A second notification arriving while the page is mounted changes the param
  // without remounting, so the thread has to follow it.
  useEffect(() => {
    if (ticketId) setOpenId(ticketId);
  }, [ticketId]);

  /** Closing drops the id from the URL, so a refresh does not reopen the thread. */
  const closeThread = useCallback(() => {
    setOpenId(null);
    if (ticketId) navigate("/admin/support", { replace: true });
  }, [navigate, ticketId]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, priority, category, assignee]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (status !== "all") params.set("status", status);
      if (priority !== "all") params.set("priority", priority);
      if (category !== "all") params.set("category", category);
      if (assignee !== "all") params.set("assignee", assignee);
      const res = await adminGet<SupportTicketsResponse>(`/support/tickets?${params.toString()}`);
      setData(res);
      setRows(res.tickets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the support inbox");
    } finally {
      setLoading(false);
    }
  }, [query, status, priority, category, assignee, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    adminGet<{ agents: SupportAgent[] }>("/support/agents")
      .then((res) => setAgents(res.agents))
      .catch(() => setAgents([]));
  }, []);

  const facet = (key: string) => data?.facets.statuses.find((s) => s.key === key)?.count;

  const statusOptions: PillOption[] = [
    {
      value: "unresolved",
      label: "Needs attention",
      count: ["open", "pending", "in_progress"].reduce((sum, k) => sum + (facet(k) ?? 0), 0),
    },
    ...(data?.statuses ?? []).map((s) => ({
      value: s,
      label: humanize(s),
      count: facet(s),
    })),
    { value: "all", label: "All" },
  ];

  const priorityOptions: PillOption[] = [
    { value: "all", label: "Any priority" },
    ...(data?.priorities ?? []).map((p) => ({
      value: p,
      label: humanize(p),
      count: data?.facets.priorities.find((f) => f.key === p)?.count,
    })),
  ];

  const unassigned = data?.unassigned ?? 0;
  const urgent = data?.facets.priorities.find((p) => p.key === "urgent")?.count ?? 0;

  return (
    <>
      <PageHeader
        title="Support"
        eyebrow="Communications"
        description="Every ticket a customer has raised, ordered by the last thing that happened on it. Replying emails the customer; an internal note never leaves this panel."
        icon={LifeBuoy}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        }
      />

      <MetricStrip>
        <Metric label="In this view" value={data?.total ?? 0} hint="Matching the filters" loading={loading} />
        <Metric
          label="Nobody assigned"
          value={unassigned}
          tone={unassigned > 0 ? "warning" : "success"}
          hint="Open, pending or in progress with no owner"
          loading={loading}
        />
        <Metric
          label="Urgent"
          value={urgent}
          tone={urgent > 0 ? "danger" : "neutral"}
          hint="Across the whole table"
          loading={loading}
        />
        <Metric
          label="Open"
          value={facet("open") ?? 0}
          tone={(facet("open") ?? 0) > 0 ? "warning" : "neutral"}
          hint="Raised and not yet picked up"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField value={search} onChange={setSearch} placeholder="Search subject or ticket id…" />
        <FilterPills options={statusOptions} value={status} onChange={setStatus} />
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <FilterPills options={priorityOptions} value={priority} onChange={setPriority} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Category">
              <SelectBox value={category} onChange={setCategory}>
                <option value="all">Any category</option>
                {(data?.categories ?? []).map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </SelectBox>
            </Field>
            <Field label="Owner">
              <SelectBox value={assignee} onChange={setAssignee}>
                <option value="all">Anyone</option>
                <option value="unassigned">Nobody</option>
                {me?.id && <option value={me.id}>Me</option>}
                {agents
                  .filter((a) => a.id !== me?.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || a.email}
                    </option>
                  ))}
              </SelectBox>
            </Field>
            {unassigned > 0 && assignee !== "unassigned" && (
              <Button variant="outline" size="sm" onClick={() => setAssignee("unassigned")}>
                <UserX className="h-3.5 w-3.5" /> Show the {unassigned} with no owner
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading && rows.length === 0 ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No tickets match these filters."
          hint={
            status !== "all" || priority !== "all" || category !== "all" || assignee !== "all" || query
              ? "Widen the filters — “All” includes resolved and closed tickets."
              : "Nothing has been raised. Customers open tickets from their own Support page."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden stagger-in">
            {rows.map((t) => (
              <article
                key={t.id}
                onClick={() => setOpenId(t.id)}
                className="press cursor-pointer rounded-2xl border border-border/60 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{t.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.requester?.email ?? "no account on file"}
                    </span>
                  </span>
                  <ToneBadge label={humanize(t.status)} tone={ticketTone(t.status)} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <ToneBadge label={humanize(t.priority)} tone={priorityTone(t.priority)} />
                  <ToneBadge label={humanize(t.category)} />
                  {!t.assignee && <ToneBadge label="No owner" tone="warning" />}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t.message_count} message{t.message_count === 1 ? "" : "s"} · last activity{" "}
                  {relativeDays(t.updated_at ?? t.created_at)}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Requester</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Messages</th>
                  <th className="px-4 py-3">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setOpenId(t.id)}
                    className="cursor-pointer hover:bg-secondary/30"
                    title="Open the thread"
                  >
                    <td className="max-w-[280px] px-4 py-3">
                      <span className="block truncate font-medium">{t.subject}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {humanize(t.category)}
                        {t.workspace ? ` · ${t.workspace.name}` : ""}
                      </span>
                    </td>
                    <td className="max-w-[200px] px-4 py-3">
                      {t.requester ? (
                        <>
                          <span className="block truncate">{t.requester.name || t.requester.email}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {t.requester.email}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">no account on file</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(t.status)} tone={ticketTone(t.status)} />
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(t.priority)} tone={priorityTone(t.priority)} />
                    </td>
                    <td className="max-w-[170px] px-4 py-3">
                      {t.assignee ? (
                        <span className="block truncate text-xs">
                          {t.assignee.name || t.assignee.email}
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-warning">nobody</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{t.message_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="block tabular-nums">
                        {formatDateTime(t.updated_at ?? t.created_at)}
                      </span>
                      <span className="block text-[11px]">
                        {relativeDays(t.updated_at ?? t.created_at)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            noun="tickets"
            onPage={setPage}
          />
        </>
      )}

      {openId && (
        <SupportTicketDialog
          ticketId={openId}
          canManage={canManage}
          currentAdminId={me?.id ?? null}
          onClose={closeThread}
          onChanged={load}
        />
      )}
    </>
  );
}
