// Admin Workspaces (/admin/workspaces) — §45.
//
// The Users page answers "who is this person". This one answers "what does this
// account actually contain": how many projects, how many running resources, how
// many people can touch them, and whether the plan it is on is the plan it is
// currently entitled to.
//
// That last pair is the reason `plan_key` and `effective_plan_key` are both shown.
// They agree almost always; when they disagree the workspace is sitting on a plan
// whose subscription has lapsed or whose period has ended, and the server has
// already stopped honouring it. A page that printed only one of them would hide
// exactly the case an operator is looking for.
//
// No plan controls here. Changing what a workspace pays for is the billing
// override on the Subscriptions page (§59), which records the reason and does not
// invent a payment. A second door onto the same column is how "just bump them to
// Pro" ends up indistinguishable from a real purchase.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Download, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import {
  AccountCell,
  FilterPills,
  ListEmpty,
  ListError,
  ListSkeleton,
  Metric,
  MetricStrip,
  Pagination,
  SearchField,
  ToneBadge,
  type PillOption,
} from "@/components/admin/AdminList";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminDownload, adminGet } from "@/lib/adminApi";
import type { WorkspaceRow, WorkspacesResponse } from "@/lib/adminWorkspaceTypes";
import { billingTone, formatDate, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function AdminWorkspaces() {
  const navigate = useNavigate();
  const { can } = useAdminMe();

  const [data, setData] = useState<WorkspacesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, plan, status]);

  /** The filter querystring, shared by the table and the CSV export. */
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (plan !== "all") p.set("plan", plan);
    if (status !== "all") p.set("status", status);
    return p;
  }, [query, plan, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams(params);
      p.set("page", String(page));
      p.set("pageSize", String(PAGE_SIZE));
      setData(await adminGet<WorkspacesResponse>(`/workspaces?${p.toString()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }, [params, page]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.workspaces ?? [];

  // Filter vocabularies come from the API's facets, so a pill never offers a plan
  // that no workspace is on.
  const planOptions: PillOption[] = useMemo(
    () => [
      { value: "all", label: "All plans" },
      ...(data?.facets.plans ?? []).map((f) => ({
        value: f.key,
        label: humanize(f.key),
        count: f.count,
      })),
    ],
    [data],
  );

  const statusOptions: PillOption[] = useMemo(
    () => [
      { value: "all", label: "Any status" },
      ...(data?.facets.statuses ?? []).map((f) => ({
        value: f.key,
        label: humanize(f.key),
        count: f.count,
      })),
    ],
    [data],
  );

  /** Counted on this page only, and labelled as such (§53). */
  const onPage = useMemo(
    () => ({
      lapsed: rows.filter((r) => r.plan_key !== r.effective_plan_key).length,
      empty: rows.filter((r) => r.resources === 0).length,
      shared: rows.filter((r) => r.members > 1).length,
    }),
    [rows],
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const p = new URLSearchParams(params);
      await adminDownload(`/workspaces/export?${p.toString()}`, "workspaces.csv");
      toast.success("Export downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The export failed.");
    } finally {
      setExporting(false);
    }
  };

  const open = (id: string) => navigate(`/admin/workspaces/${id}`);

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Every customer account, with what it contains and who can reach it. Open one to see its projects, environments and team."
        icon={Boxes}
        actions={
          <div className="flex items-center gap-2">
            {can("workspaces.view") && (
              <Button
                variant="outline"
                onClick={exportCsv}
                disabled={exporting || loading}
                className="h-10 border-border/60 bg-background hover:bg-secondary/80"
              >
                <Download className={cn("h-4 w-4", exporting && "animate-pulse")} />
                <span className="hidden sm:inline">{exporting ? "Exporting…" : "Export CSV"}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
            </Button>
          </div>
        }
      />

      <MetricStrip>
        <Metric
          label="Workspaces"
          value={data?.total ?? 0}
          hint="Matching the current filter"
          loading={loading}
        />
        <Metric
          label="Plan not honoured"
          value={onPage.lapsed}
          tone={onPage.lapsed > 0 ? "warning" : "neutral"}
          hint="On this page — paid plan set, but access has lapsed"
          loading={loading}
        />
        <Metric
          label="Nothing deployed"
          value={onPage.empty}
          hint="On this page — no services or databases yet"
          loading={loading}
        />
        <Metric
          label="Shared"
          value={onPage.shared}
          tone={onPage.shared > 0 ? "info" : "neutral"}
          hint="On this page — more than one team member"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search workspace name or id, owner name or email…"
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <FilterPills options={planOptions} value={plan} onChange={setPlan} />
          <FilterPills options={statusOptions} value={status} onChange={setStatus} />
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No workspace matches these filters."
          hint={
            query || plan !== "all" || status !== "all"
              ? "Clear the search or choose a different plan."
              : "A workspace is created with the first account that signs up."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden stagger-in">
            {rows.map((row) => (
              <article
                key={row.id}
                onClick={() => open(row.id)}
                className="press cursor-pointer rounded-2xl border border-border/60 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <AccountCell
                    workspaceName={row.name}
                    email={row.owner.email}
                    userId={row.id}
                  />
                  <PlanBadges row={row} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <ToneBadge
                    label={humanize(row.subscription_status)}
                    tone={billingTone(row.subscription_status)}
                  />
                  {row.manual_override && <ToneBadge label="Manual override" tone="info" />}
                  {row.owner.status !== "active" && (
                    <ToneBadge label={`Owner ${humanize(row.owner.status)}`} tone="danger" />
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {row.projects} project{row.projects === 1 ? "" : "s"} · {row.resources} resource
                  {row.resources === 1 ? "" : "s"} · {row.members} member
                  {row.members === 1 ? "" : "s"} · created {formatDate(row.created_at)}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Workspace</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Billing</th>
                  <th className="px-4 py-3 text-right">Projects</th>
                  <th className="px-4 py-3 text-right">Resources</th>
                  <th className="px-4 py-3 text-right">Team</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => open(row.id)}
                    className="cursor-pointer hover:bg-secondary/30"
                    title="Open this workspace"
                  >
                    <td className="max-w-[280px] px-4 py-3">
                      <AccountCell
                        workspaceName={row.name}
                        email={row.owner.email}
                        userId={row.id}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <PlanBadges row={row} />
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge
                        label={humanize(row.subscription_status)}
                        tone={billingTone(row.subscription_status)}
                      />
                      {row.manual_override && (
                        <span className="mt-1 block text-[11px] text-brand">Manual override</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.projects}</td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        row.resources === 0 && "text-muted-foreground",
                      )}
                    >
                      {row.resources}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.members}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDate(row.created_at)}
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
            noun="workspaces"
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}

/**
 * The plan, and — only when they differ — what is actually being honoured. Showing
 * "Pro" alone on a workspace the server has already downgraded to Hobby would be a
 * number that contradicts the system's own behaviour.
 */
function PlanBadges({ row }: { row: WorkspaceRow }) {
  const lapsed = row.plan_key !== row.effective_plan_key;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ToneBadge label={humanize(row.plan_key)} tone={lapsed ? "neutral" : "info"} />
      {lapsed && (
        <ToneBadge
          label={`served as ${humanize(row.effective_plan_key)}`}
          tone="warning"
          title="The paid plan is not live, so the platform is applying the free plan's limits."
        />
      )}
    </span>
  );
}
