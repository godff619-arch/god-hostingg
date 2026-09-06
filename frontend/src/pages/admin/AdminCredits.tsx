// Admin Credits (/admin/credits) — §13.
//
// A wallet ledger, not a balance editor. Every row is signed cents with the
// balance the transaction produced (`balance_after`), which is what makes the
// ledger replayable: if the balance column and the sum of the ledger ever
// disagree, the ledger is the truth and the bug is visible here.
//
// Two things this page says out loud:
//   • Outstanding credit is a liability, not revenue. It is the number finance
//     asks for, so it is the first metric.
//   • Removing credit is the same endpoint with a negative amount. The server
//     refuses to take a balance below zero, so a revoke is capped at what the
//     account actually holds — the form shows that cap rather than discovering it
//     through a 400.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Minus, Plus, RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
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
import {
  AccountCell,
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
import { AccountPicker, type PickedAccount } from "@/components/admin/AccountPicker";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { CreditsResponse, CreditTransactionRow } from "@/lib/adminBillingTypes";
import { formatDateTime, humanize, inputToCents } from "@/lib/adminFormat";
import { useAdminMe } from "@/hooks/useAdminMe";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function AdminCredits() {
  const { can } = useAdminMe();
  const mayManage = can("credits.manage");

  const [rows, setRows] = useState<CreditTransactionRow[]>([]);
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);

  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [direction, setDirection] = useState<"grant" | "revoke">("grant");
  const [amount, setAmount] = useState("10.00");
  const [creditKind, setCreditKind] = useState("grant");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, kind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (kind !== "all") params.set("kind", kind);
      const res = await adminGet<CreditsResponse>(`/credits?${params.toString()}`);
      setRows(res.transactions);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the credit ledger");
    } finally {
      setLoading(false);
    }
  }, [query, kind, page]);

  useEffect(() => {
    load();
  }, [load]);

  const kindOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "All" },
      ...(data?.kinds ?? []).map((k) => ({ value: k, label: humanize(k) })),
    ],
    [data?.kinds],
  );

  const openDialog = (next: "grant" | "revoke") => {
    setDirection(next);
    setCreditKind(next);
    setAccount(null);
    setAmount("10.00");
    setReason("");
    setOpen(true);
  };

  const submit = async () => {
    if (!account) {
      toast.error("Pick an account first.");
      return;
    }
    if (!reason.trim()) {
      toast.error("A reason is required — it goes in the audit log.");
      return;
    }
    const cents = inputToCents(amount);
    if (cents === null || cents <= 0) {
      toast.error("Enter an amount greater than zero.");
      return;
    }
    setSaving(true);
    try {
      const res = await adminSend<{ message?: string }>("/credits", "POST", {
        workspace_id: account.workspace_id,
        amount_cents: direction === "grant" ? cents : -cents,
        kind: creditKind,
        reason,
      });
      toast.success(res.message || "Balance updated.");
      setOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The balance was not changed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Credits"
        description="The wallet ledger. Positive rows grant credit, negative rows take it back, and every row records who and why."
        icon={Wallet}
        actions={
          <>
            {mayManage && (
              <>
                <Button variant="outline" className="border-border/60" onClick={() => openDialog("revoke")}>
                  <Minus className="h-4 w-4" /> Remove
                </Button>
                <Button onClick={() => openDialog("grant")}>
                  <Plus className="h-4 w-4" /> Grant credit
                </Button>
              </>
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
        <Metric
          label="Outstanding credit"
          value={data?.outstanding_label ?? "—"}
          tone="warning"
          hint="Unspent — a liability, not revenue"
          loading={loading}
        />
        <Metric
          label="Accounts holding credit"
          value={data?.top_balances.length ?? 0}
          hint="With a balance above zero"
          loading={loading}
        />
        <Metric
          label="Ledger rows"
          value={data?.total ?? 0}
          hint="Matching the current filter"
          loading={loading}
        />
        <Metric
          label="Largest balance"
          value={data?.top_balances[0]?.balance_label ?? "—"}
          hint={data?.top_balances[0]?.workspace_name ?? "No credit on file"}
          loading={loading}
        />
      </MetricStrip>

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search account or reason…"
        />
        <FilterPills options={kindOptions} value={kind} onChange={setKind} />
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No credit movements match these filters."
          hint={
            query || kind !== "all"
              ? "Clear the search or the kind filter."
              : "Grant credit to an account and the row appears here."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden stagger-in">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <AccountCell
                    workspaceName={row.workspace_name}
                    email={row.user_email}
                    userId={row.user_id}
                  />
                  <span
                    className={cn(
                      "shrink-0 font-bold tabular-nums",
                      row.amount_cents >= 0 ? "text-success" : "text-danger",
                    )}
                  >
                    {row.amount_cents >= 0 ? "+" : "−"}
                    {row.amount_label.replace("-", "")}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <ToneBadge label={humanize(row.kind)} />
                  <span className="text-[11px] text-muted-foreground">
                    balance after {row.balance_after_label}
                  </span>
                </div>
                {row.reason && <p className="mt-2 text-xs text-muted-foreground">{row.reason}</p>}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {formatDateTime(row.created_at)}
                  {row.admin_email ? ` · ${row.admin_email}` : ""}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Change</th>
                  <th className="px-4 py-3 text-right">Balance after</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">By</th>
                  <th className="px-4 py-3">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-secondary/30">
                    <td className="max-w-[220px] px-4 py-3">
                      <AccountCell
                        workspaceName={row.workspace_name}
                        email={row.user_email}
                        userId={row.user_id}
                      />
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-semibold tabular-nums",
                        row.amount_cents >= 0 ? "text-success" : "text-danger",
                      )}
                    >
                      {row.amount_cents >= 0 ? "+" : "−"}
                      {row.amount_label.replace("-", "")}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.balance_after_label}
                    </td>
                    <td className="px-4 py-3">
                      <ToneBadge label={humanize(row.kind)} />
                    </td>
                    <td className="max-w-[260px] px-4 py-3 text-muted-foreground">
                      <span className="block truncate" title={row.reason ?? ""}>
                        {row.reason || "—"}
                      </span>
                    </td>
                    <td className="max-w-[180px] px-4 py-3">
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.admin_email ?? "system"}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {formatDateTime(row.created_at)}
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
            noun="movements"
            onPage={setPage}
          />
        </>
      )}

      {data && data.top_balances.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">Largest balances</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 stagger-in">
            {data.top_balances.slice(0, 9).map((b) => (
              <div
                key={b.workspace_id ?? b.user_id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5"
              >
                <AccountCell
                  workspaceName={b.workspace_name}
                  email={b.user_email}
                  userId={b.user_id}
                />
                <span className="shrink-0 font-semibold tabular-nums">{b.balance_label}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <div
                className={cn(
                  "mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl",
                  direction === "grant" ? "bg-success-surface" : "bg-danger-surface",
                )}
              >
                {direction === "grant" ? (
                  <Plus className="h-6 w-6 text-success" />
                ) : (
                  <Minus className="h-6 w-6 text-danger" />
                )}
              </div>
              <DialogTitle className="text-center">
                {direction === "grant" ? "Grant credit" : "Remove credit"}
              </DialogTitle>
              <DialogDescription className="text-center">
                {direction === "grant"
                  ? "Credit is spent against future invoices. It is not a payment and does not change the plan."
                  : "The balance cannot go below zero — the server caps a removal at what the account holds."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <Field label="Account">
                <AccountPicker value={account} onChange={setAccount} />
              </Field>

              <Field label="Amount" hint="In the platform currency.">
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>

              <Field label="Kind" hint="Shows up in the ledger and the kind filter.">
                <SelectBox value={creditKind} onChange={setCreditKind}>
                  {(data?.kinds ?? []).map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </SelectBox>
              </Field>

              <Field label="Reason (required)" hint="Stored on the ledger row and in the audit log (§24).">
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Goodwill credit for the 4 Sep outage, agreed on ticket #4207."
                />
              </Field>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant={direction === "grant" ? "default" : "destructive"}
                onClick={submit}
                disabled={saving || !account || !reason.trim()}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {direction === "grant" ? "Grant credit" : "Remove credit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
