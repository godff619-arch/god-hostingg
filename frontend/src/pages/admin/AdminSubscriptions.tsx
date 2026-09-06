// Admin Subscriptions (/admin/subscriptions) — §8, §37, §59.
//
// The one screen that answers "what is this account actually entitled to right
// now, and why". That question needs two columns rather than one, which is the
// whole reason this page is not just a list of plan names:
//
//   • `plan_key` is what the account was sold.
//   • `effective_plan` is what the server will grant on the next request.
//
// They diverge when a paid period lapses or a payment fails, and the rows where
// `entitlement_matches_plan === false` are the only ones worth an operator's
// attention. So that flag gets its own filter pill and its own warning badge.
//
// Two deliberate absences:
//   • No sort controls. `GET /subscriptions` orders by `updated_at desc` and takes
//     no sort parameter, and a header that looks clickable but does nothing is
//     worse than a header that doesn't.
//   • No "mark as paid" or "add payment" action. Nothing on this page can create
//     money (§34/§59) — an admin grant goes through the override, which writes
//     `payment_status = 'none'` and says so in the dialog.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CreditCard,
  Download,
  Gift,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Timer,
  XCircle,
} from "lucide-react";
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
import {
  SubscriptionActionDialog,
  type SubscriptionAction,
} from "@/components/admin/SubscriptionActionDialog";
import { adminDownload, adminGet } from "@/lib/adminApi";
import type { Plan } from "@/lib/adminTypes";
import type { SubscriptionRow, SubscriptionsResponse } from "@/lib/adminBillingTypes";
import { billingTone, formatDate, humanize, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

/** Which actions make sense for a row, so no button is offered that would 409. */
function actionsFor(row: SubscriptionRow): SubscriptionAction[] {
  const list: SubscriptionAction[] = ["override"];
  if (row.cancel_at_period_end) list.push("resume");
  else if (row.live) list.push("cancel");
  if (row.live && row.plan_key !== "free") list.push("extend");
  return list;
}

const ACTION_ICON: Record<SubscriptionAction, typeof Gift> = {
  override: Gift,
  cancel: XCircle,
  resume: RotateCcw,
  extend: Timer,
};

const ACTION_LABEL: Record<SubscriptionAction, string> = {
  override: "Change plan by hand",
  cancel: "Cancel subscription",
  resume: "Withdraw cancellation",
  extend: "Extend paid period",
};

export default function AdminSubscriptions() {
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<SubscriptionsResponse["facets"]>({
    statuses: [],
    providers: [],
    plans: [],
  });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [plan, setPlan] = useState("all");
  const [provider, setProvider] = useState("all");
  const [override, setOverride] = useState("all");
  const [page, setPage] = useState(1);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [action, setAction] = useState<SubscriptionAction | null>(null);
  const [target, setTarget] = useState<SubscriptionRow | null>(null);

  // 350 ms, same as every other admin list.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, status, plan, provider, override]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: query,
        status: status === "all" ? "" : status,
        plan: plan === "all" ? "" : plan,
        provider: provider === "all" ? "" : provider,
        manual_override: override === "all" ? "" : override,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const res = await adminGet<SubscriptionsResponse>(`/subscriptions?${params.toString()}`);
      setRows(res.subscriptions);
      setTotal(res.total);
      setFacets(res.facets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscriptions");
    } finally {
      setLoading(false);
    }
  }, [query, status, plan, provider, override, page]);

  useEffect(() => {
    load();
  }, [load]);

  // The plan list is only needed by the override dialog; fetch it once.
  useEffect(() => {
    adminGet<Plan[]>("/plans")
      .then(setPlans)
      .catch(() => setPlans([]));
  }, []);

  const statusOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "All" },
      ...facets.statuses.map((s) => ({
        value: s.key,
        label: humanize(s.key),
        count: s.count,
      })),
    ],
    [facets.statuses],
  );

  const providerOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "Any provider" },
      ...facets.providers.map((p) => ({
        value: p.key,
        label: humanize(p.key),
        count: p.count,
      })),
    ],
    [facets.providers],
  );

  const planOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "Any plan" },
      ...facets.plans.map((p) => ({ value: p.key, label: p.name })),
    ],
    [facets.plans],
  );

  // Counted over the visible page only, and labelled as such — the API does not
  // aggregate these, and inventing a total here would be a fake number (§53).
  const onPage = {
    mismatched: rows.filter((r) => !r.entitlement_matches_plan).length,
    comped: rows.filter((r) => r.manual_override).length,
    cancelling: rows.filter((r) => r.cancel_at_period_end).length,
  };

  const exportCsv = async () => {
    const params = new URLSearchParams({
      q: query,
      status: status === "all" ? "" : status,
      plan: plan === "all" ? "" : plan,
      provider: provider === "all" ? "" : provider,
      manual_override: override === "all" ? "" : override,
    });
    try {
      await adminDownload(`/subscriptions/export?${params.toString()}`, "subscriptions.csv");
      toast.success("Export downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  };

  const start = (row: SubscriptionRow, next: SubscriptionAction) => {
    setTarget(row);
    setAction(next);
    setOpenMenu(null);
  };

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="What every account is sold, what it is actually entitled to, and who changed it by hand."
        icon={CreditCard}
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} className="border-border/60">
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <MetricStrip>
        <Metric label="Accounts" value={total} hint="Matching the current filters" loading={loading} />
        <Metric
          label="Entitlement mismatch"
          value={onPage.mismatched}
          tone={onPage.mismatched ? "warning" : "neutral"}
          hint="On this page — sold one plan, granted another"
          loading={loading}
        />
        <Metric
          label="Comped by hand"
          value={onPage.comped}
          tone={onPage.comped ? "info" : "neutral"}
          hint="On this page — manual override, no payment"
          loading={loading}
        />
        <Metric
          label="Cancelling"
          value={onPage.cancelling}
          tone={onPage.cancelling ? "danger" : "neutral"}
          hint="On this page — live until the period ends"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search workspace, owner email, or subscription id…"
        />
        <FilterPills options={statusOptions} value={status} onChange={setStatus} />
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <FilterPills options={planOptions} value={plan} onChange={setPlan} />
          <FilterPills options={providerOptions} value={provider} onChange={setProvider} />
          <FilterPills
            options={[
              { value: "all", label: "Paid & comped" },
              { value: "true", label: "Comped only" },
              { value: "false", label: "Paid only" },
            ]}
            value={override}
            onChange={setOverride}
          />
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No subscriptions match these filters."
          hint={
            query || status !== "all" || plan !== "all" || provider !== "all" || override !== "all"
              ? "Clear the search or a filter to widen the result."
              : "Every workspace gets a row here as soon as it exists."
          }
        />
      ) : (
        <>
          {/* Mobile: one card per account. */}
          <div className="space-y-3 md:hidden stagger-in">
            {rows.map((row) => (
              <article
                key={row.workspace_id ?? row.user_id ?? Math.random().toString()}
                className="rounded-2xl border border-border/60 bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <AccountCell
                    workspaceName={row.workspace_name}
                    email={row.user_email}
                    userId={row.user_id}
                  />
                  <ToneBadge
                    label={humanize(row.subscription_status)}
                    tone={billingTone(row.subscription_status)}
                  />
                </div>

                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Sold</dt>
                    <dd className="font-medium">{row.plan_name}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Entitled to</dt>
                    <dd
                      className={cn(
                        "font-medium",
                        !row.entitlement_matches_plan && "text-warning",
                      )}
                    >
                      {row.effective_plan_name}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Period ends</dt>
                    <dd className="font-medium">
                      {formatDate(row.current_period_end)}
                      {row.current_period_end && (
                        <span className="ml-1 text-muted-foreground">
                          ({relativeDays(row.current_period_end)})
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {row.manual_override && <ToneBadge label="Comped" tone="info" />}
                  {row.cancel_at_period_end && <ToneBadge label="Cancelling" tone="danger" />}
                  {!row.entitlement_matches_plan && (
                    <ToneBadge label="Entitlement mismatch" tone="warning" />
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/40 pt-3">
                  {actionsFor(row).map((a) => {
                    const Icon = ACTION_ICON[a];
                    return (
                      <Button
                        key={a}
                        variant="outline"
                        size="sm"
                        className="border-border/60"
                        onClick={() => start(row, a)}
                      >
                        <Icon className="h-3.5 w-3.5" /> {ACTION_LABEL[a]}
                      </Button>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>

          {/* Desktop table. */}
          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Sold</th>
                  <th className="px-4 py-3">Entitled to</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Period ends</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => {
                  const available = actionsFor(row);
                  const menuOpen = openMenu === row.workspace_id;
                  return (
                    <tr key={row.workspace_id ?? row.user_id} className="hover:bg-secondary/30">
                      <td className="max-w-[260px] px-4 py-3">
                        <AccountCell
                          workspaceName={row.workspace_name}
                          email={row.user_email}
                          userId={row.user_id}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className="block font-medium">{row.plan_name}</span>
                        {row.manual_override && (
                          <span
                            className="block text-[11px] text-brand"
                            title={row.manual_override_reason ?? undefined}
                          >
                            granted by hand
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.entitlement_matches_plan ? (
                          <span className="text-muted-foreground">same</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 font-medium text-warning">
                            <ShieldAlert className="h-3.5 w-3.5" />
                            {row.effective_plan_name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ToneBadge
                            label={humanize(row.subscription_status)}
                            tone={billingTone(row.subscription_status)}
                          />
                          {row.payment_status !== "none" &&
                            row.payment_status !== row.subscription_status && (
                              <ToneBadge
                                label={humanize(row.payment_status)}
                                tone={billingTone(row.payment_status)}
                                title="Payment status"
                              />
                            )}
                          {row.cancel_at_period_end && (
                            <ToneBadge label="Cancelling" tone="danger" />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {humanize(row.billing_provider)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="block tabular-nums">
                          {formatDate(row.current_period_end)}
                        </span>
                        {row.current_period_end && (
                          <span className="block text-[11px] text-muted-foreground">
                            {relativeDays(row.current_period_end)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative flex items-center justify-end gap-1">
                          {available.slice(0, 2).map((a) => {
                            const Icon = ACTION_ICON[a];
                            return (
                              <Button
                                key={a}
                                variant="ghost"
                                size="icon"
                                title={ACTION_LABEL[a]}
                                aria-label={ACTION_LABEL[a]}
                                onClick={() => start(row, a)}
                              >
                                <Icon className="h-4 w-4" />
                              </Button>
                            );
                          })}
                          {available.length > 2 && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="More actions"
                                aria-label="More actions"
                                onClick={() =>
                                  setOpenMenu(menuOpen ? null : row.workspace_id)
                                }
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                              {menuOpen && (
                                <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg">
                                  {available.slice(2).map((a) => {
                                    const Icon = ACTION_ICON[a];
                                    return (
                                      <button
                                        key={a}
                                        type="button"
                                        onClick={() => start(row, a)}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-secondary"
                                      >
                                        <Icon className="h-3.5 w-3.5" /> {ACTION_LABEL[a]}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            noun="accounts"
            onPage={setPage}
          />
        </>
      )}

      <SubscriptionActionDialog
        action={action}
        row={target}
        plans={plans}
        onClose={() => {
          setAction(null);
          setTarget(null);
        }}
        onDone={load}
      />
    </>
  );
}
