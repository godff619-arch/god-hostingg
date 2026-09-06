// Admin Coupons (/admin/coupons) — §13.
//
// A coupon has five reasons for not working and only one of them is "switched
// off": it can be disabled, expired, not started yet, or fully redeemed. The
// server derives `state` and `usable` once so every surface agrees, and this page
// prints that state rather than re-deriving it from dates — which is how a list
// ends up disagreeing with the checkout that rejected the code.
//
// Delete behaves in two ways on purpose, and the confirmation says which one will
// happen before it happens: an unused coupon is deleted, a redeemed one is
// disabled so its redemption rows keep pointing at something real. Offering a
// "Delete" that silently does something else is the fake-button problem in its
// most expensive form.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  TicketPercent,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
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
  Field,
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
import { Textarea } from "@/components/ui/textarea";
import { CouponEditorDialog } from "@/components/admin/CouponEditorDialog";
import { CouponRedemptionsDialog } from "@/components/admin/CouponRedemptionsDialog";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { CouponRow, CouponsResponse } from "@/lib/adminBillingTypes";
import { formatDate, humanize } from "@/lib/adminFormat";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

const ACTIVE_FILTERS: PillOption[] = [
  { value: "all", label: "All" },
  { value: "true", label: "Switched on" },
  { value: "false", label: "Switched off" },
];

/** The server's five states, mapped to the badge tones the rest of the panel uses. */
function stateTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (state === "active") return "success";
  if (state === "scheduled") return "warning";
  if (state === "exhausted") return "warning";
  if (state === "expired" || state === "disabled") return "danger";
  return "neutral";
}

function durationLabel(row: CouponRow): string {
  if (row.duration === "forever") return "Every invoice";
  if (row.duration === "months") return `${row.duration_months ?? 0} months`;
  return "First invoice";
}

export default function AdminCoupons() {
  const { can } = useAdminMe();
  const mayManage = can("coupons.manage");

  const [rows, setRows] = useState<CouponRow[]>([]);
  const [data, setData] = useState<CouponsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CouponRow | null>(null);
  const [redemptionsOf, setRedemptionsOf] = useState<CouponRow | null>(null);
  const [deleting, setDeleting] = useState<CouponRow | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, activeFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (activeFilter !== "all") params.set("active", activeFilter);
      const res = await adminGet<CouponsResponse>(`/coupons?${params.toString()}`);
      setRows(res.coupons);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coupons");
    } finally {
      setLoading(false);
    }
  }, [query, activeFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const onPage = useMemo(
    () => ({
      usable: rows.filter((r) => r.usable).length,
      redemptions: rows.reduce((sum, r) => sum + r.redemption_count, 0),
      stale: rows.filter((r) => r.state === "expired" || r.state === "exhausted").length,
    }),
    [rows],
  );

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (row: CouponRow) => {
    setEditing(row);
    setEditorOpen(true);
  };

  const toggleActive = async (row: CouponRow) => {
    setBusy(true);
    try {
      await adminSend(`/coupons/${row.id}`, "PATCH", { active: !row.active });
      toast.success(row.active ? `${row.code} switched off.` : `${row.code} switched on.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The coupon was not changed.");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await adminSend<{ deleted?: boolean; message?: string }>(
        `/coupons/${deleting.id}`,
        "DELETE",
        deleteReason.trim() ? { reason: deleteReason } : undefined,
      );
      toast.success(res.message || (res.deleted ? `${deleting.code} deleted.` : `${deleting.code} disabled.`));
      setDeleting(null);
      setDeleteReason("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The coupon was not removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Discount codes for checkout. A coupon reduces what is charged — it is never credit and never becomes a balance."
        icon={TicketPercent}
        actions={
          <>
            {mayManage && (
              <Button onClick={openNew}>
                <Plus className="h-4 w-4" /> New coupon
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
          </>
        }
      />

      <MetricStrip>
        <Metric label="Coupons" value={data?.total ?? 0} hint="Matching the current filter" loading={loading} />
        <Metric
          label="Usable now"
          value={onPage.usable}
          tone={onPage.usable > 0 ? "success" : "neutral"}
          hint="On this page — on, started, not expired or exhausted"
          loading={loading}
        />
        <Metric
          label="Redemptions"
          value={onPage.redemptions}
          hint="Total across the coupons on this page"
          loading={loading}
        />
        <Metric
          label="Expired or exhausted"
          value={onPage.stale}
          tone={onPage.stale > 0 ? "warning" : "neutral"}
          hint="On this page — will reject at checkout"
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField value={search} onChange={setSearch} placeholder="Search code or description…" />
        <FilterPills options={ACTIVE_FILTERS} value={activeFilter} onChange={setActiveFilter} />
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No coupons match these filters."
          hint={
            query || activeFilter !== "all"
              ? "Clear the search or the on/off filter."
              : mayManage
                ? "Create one with “New coupon”."
                : "An operator with coupon permission can create one."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-bold">{row.code}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {row.value_label} · {durationLabel(row)}
                    </span>
                  </span>
                  <ToneBadge label={humanize(row.state)} tone={stateTone(row.state)} />
                </div>
                {row.description && (
                  <p className="mt-2 text-xs text-muted-foreground">{row.description}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <ToneBadge
                    label={
                      row.plan_keys.length === 0 ? "All plans" : `${row.plan_keys.length} plan(s)`
                    }
                  />
                  <span>
                    {row.redemption_count}
                    {row.max_redemables ? ` / ${row.max_redemables}` : ""} used
                  </span>
                  {row.expires_at && <span>· expires {formatDate(row.expires_at)}</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setRedemptionsOf(row)}>
                    <Users className="h-3.5 w-3.5" /> Redemptions
                  </Button>
                  {mayManage && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => toggleActive(row)}
                      >
                        <Ban className="h-3.5 w-3.5" /> {row.active ? "Switch off" : "Switch on"}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Discount</th>
                  <th className="px-4 py-3">Applies for</th>
                  <th className="px-4 py-3">Valid on</th>
                  <th className="px-4 py-3 text-right">Used</th>
                  <th className="px-4 py-3">Window</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-secondary/30">
                    <td className="max-w-[200px] px-4 py-3">
                      <span className="block font-mono text-xs font-bold">{row.code}</span>
                      {row.description && (
                        <span
                          className="mt-0.5 block truncate text-[11px] text-muted-foreground"
                          title={row.description}
                        >
                          {row.description}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums">{row.value_label}</td>
                    <td className="px-4 py-3 text-muted-foreground">{durationLabel(row)}</td>
                    <td className="max-w-[180px] px-4 py-3">
                      {row.plan_keys.length === 0 ? (
                        <span className="text-muted-foreground">All plans</span>
                      ) : (
                        <span className="block truncate" title={row.plan_keys.join(", ")}>
                          {row.plan_keys
                            .map((k) => data?.plans.find((p) => p.key === k)?.name ?? k)
                            .join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.redemption_count}
                      {row.max_redemables !== null && (
                        <span className="text-muted-foreground"> / {row.max_redemables}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                      {row.starts_at ? formatDate(row.starts_at) : "now"} →{" "}
                      {row.expires_at ? formatDate(row.expires_at) : "never"}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(row.state)} tone={stateTone(row.state)} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Who redeemed it"
                          aria-label="Who redeemed it"
                          onClick={() => setRedemptionsOf(row)}
                        >
                          <Users className="h-4 w-4" />
                        </Button>
                        {mayManage && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              aria-label="Edit coupon"
                              onClick={() => openEdit(row)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              title={row.active ? "Switch off" : "Switch on"}
                              aria-label={row.active ? "Switch off" : "Switch on"}
                              onClick={() => toggleActive(row)}
                            >
                              <Ban
                                className={cn(
                                  "h-4 w-4",
                                  row.active ? "text-muted-foreground" : "text-success",
                                )}
                              />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={
                                row.redemption_count > 0
                                  ? "Redeemed — this will disable it"
                                  : "Delete"
                              }
                              aria-label="Delete coupon"
                              onClick={() => {
                                setDeleting(row);
                                setDeleteReason("");
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </>
                        )}
                      </div>
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
            noun="coupons"
            onPage={setPage}
          />
        </>
      )}

      <CouponEditorDialog
        open={editorOpen}
        coupon={editing}
        plans={data?.plans ?? []}
        kinds={data?.kinds ?? ["fixed", "percent"]}
        durations={data?.durations ?? ["once", "forever", "months"]}
        onClose={() => setEditorOpen(false)}
        onSaved={load}
      />

      <CouponRedemptionsDialog coupon={redemptionsOf} onClose={() => setRedemptionsOf(null)} />

      {deleting && (
        <Dialog open onOpenChange={(o) => !o && setDeleting(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-surface">
                <Trash2 className="h-6 w-6 text-danger" />
              </div>
              <DialogTitle className="text-center font-mono">{deleting.code}</DialogTitle>
              <DialogDescription className="text-center">
                {deleting.redemption_count > 0
                  ? `${deleting.redemption_count} account(s) already redeemed this code, so it will be switched off rather than deleted — the redemption rows have to keep pointing at something real.`
                  : "Nobody has redeemed this code, so it will be deleted outright."}
              </DialogDescription>
            </DialogHeader>

            <Field label="Reason (optional)" hint="Stored in the audit log (§24).">
              <Textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                rows={2}
                placeholder="e.g. Campaign ended; code leaked on a deals site."
              />
            </Field>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {deleting.redemption_count > 0 ? "Switch it off" : "Delete it"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
