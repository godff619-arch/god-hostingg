// Admin Cards on file (/admin/cards) — §6.
//
// The whole page is read-only, and that is the point. There is no "edit card"
// action because the platform never held the number: `PaymentMethod` stores a
// provider token plus brand/last4/expiry, and the token is not in the server's
// select list, so it cannot reach this screen even by accident.
//
// `never_stored` comes back from the API on every request and is printed on the
// page rather than kept as a comment. It is the contract in the customer's words:
// if someone later asks "can you read me the card number from the admin panel",
// the answer is on screen.
//
// The only judgement this page adds is expiry. A card that expires inside 60 days
// is the reason next month's renewal will fail, so it is surfaced as a metric and
// a badge instead of leaving an operator to read `04/26` and do the arithmetic.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, Lock, RefreshCw, ShieldCheck, Star } from "lucide-react";
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
import { adminGet } from "@/lib/adminApi";
import type { CardListRow, CardsResponse } from "@/lib/adminBillingTypes";
import { formatDate, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;

const PROVIDERS: PillOption[] = [
  { value: "all", label: "All providers" },
  { value: "stripe", label: "Stripe" },
  { value: "razorpay", label: "Razorpay" },
  { value: "paypal", label: "PayPal" },
  { value: "manual", label: "Manual" },
];

const STATUSES: PillOption[] = [
  { value: "all", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "removed", label: "Removed" },
];

/**
 * Months until the card stops working, from its expiry month. Negative means it
 * already has. `exp_month` is 1-based, so the card is good through the *end* of
 * that month — hence the first day of the following month.
 */
function monthsLeft(card: CardListRow): number {
  const dies = new Date(card.exp_year, card.exp_month, 1).getTime();
  return Math.round((dies - Date.now()) / (1000 * 60 * 60 * 24 * 30.4375));
}

function expiryTone(card: CardListRow): { tone: "danger" | "warning" | null; label: string } {
  const left = monthsLeft(card);
  if (left <= 0) return { tone: "danger", label: "Expired" };
  if (left <= 2) return { tone: "warning", label: `Expires in ${left} mo` };
  return { tone: null, label: "" };
}

export default function AdminCards() {
  const [rows, setRows] = useState<CardListRow[]>([]);
  const [data, setData] = useState<CardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [status, setStatus] = useState("all");
  const [brand, setBrand] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, provider, status, brand]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      if (provider !== "all") params.set("provider", provider);
      if (status !== "all") params.set("status", status);
      if (brand !== "all") params.set("brand", brand);
      const res = await adminGet<CardsResponse>(`/cards?${params.toString()}`);
      setRows(res.cards);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payment methods");
    } finally {
      setLoading(false);
    }
  }, [query, provider, status, brand, page]);

  useEffect(() => {
    load();
  }, [load]);

  const brandOptions = useMemo<PillOption[]>(
    () => [
      { value: "all", label: "All brands" },
      ...(data?.facets.brands ?? []).map((b) => ({
        value: b.key,
        label: humanize(b.key),
        count: b.count,
      })),
    ],
    [data?.facets.brands],
  );

  const expiringSoon = rows.filter((c) => {
    const left = monthsLeft(c);
    return left > 0 && left <= 2;
  }).length;
  const expired = rows.filter((c) => monthsLeft(c) <= 0).length;

  return (
    <>
      <PageHeader
        title="Cards on file"
        description="Every saved payment method, masked. The platform stores a provider token and the last four digits — nothing that could be used to charge a card elsewhere."
        icon={CreditCard}
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
        <Metric label="Cards on file" value={data?.total ?? 0} hint="Matching the current filter" loading={loading} />
        <Metric
          label="Expiring soon"
          value={expiringSoon}
          tone={expiringSoon > 0 ? "warning" : "neutral"}
          hint="Within two months, on this page"
          loading={loading}
        />
        <Metric
          label="Already expired"
          value={expired}
          tone={expired > 0 ? "danger" : "neutral"}
          hint="On this page — renewals will fail"
          loading={loading}
        />
        <Metric
          label="Card numbers stored"
          value="0"
          tone="success"
          hint="By design, and not configurable"
          loading={loading}
        />
      </MetricStrip>

      {data && data.never_stored.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-border/60 bg-secondary/30 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-success-surface">
            <Lock className="h-4 w-4 text-success" />
          </span>
          <div className="min-w-0 text-sm">
            <p className="font-semibold">This table cannot show a card number.</p>
            <p className="mt-1 text-muted-foreground">
              The database has no column for{" "}
              {data.never_stored.map((f, i) => (
                <span key={f}>
                  {i > 0 && (i === data.never_stored.length - 1 ? " or " : ", ")}
                  <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">
                    {f.replace(/_/g, " ")}
                  </code>
                </span>
              ))}
              . Charges are made against a provider token, which is also withheld from this
              response.
            </p>
          </div>
        </div>
      )}

      <div className="mb-4 space-y-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search last four digits, name on card or account…"
        />
        <div className="space-y-2">
          <FilterPills options={brandOptions} value={brand} onChange={setBrand} />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <FilterPills options={PROVIDERS} value={provider} onChange={setProvider} />
            <FilterPills options={STATUSES} value={status} onChange={setStatus} />
          </div>
        </div>
      </div>

      {error && <ListError message={error} onRetry={load} />}

      {loading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <ListEmpty
          message="No payment methods match these filters."
          hint={
            query || provider !== "all" || status !== "all" || brand !== "all"
              ? "Clear the search or the filters."
              : "A card appears here once a customer saves one at checkout."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {rows.map((card) => {
              const exp = expiryTone(card);
              return (
                <article key={card.id} className="rounded-2xl border border-border/60 bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-mono text-sm font-semibold">
                        {card.label}
                        {card.is_default && (
                          <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {humanize(card.provider)} · {card.expiry_label}
                      </span>
                    </span>
                    <ToneBadge label={humanize(card.status)} tone={card.status === "active" ? "success" : "neutral"} />
                  </div>
                  <div className="mt-3">
                    <AccountCell
                      workspaceName={card.workspace_name}
                      email={card.user_email}
                      userId={card.user_id}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {exp.tone && <ToneBadge label={exp.label} tone={exp.tone} />}
                    <ToneBadge label={`${humanize(card.funding)} ${humanize(card.type)}`} />
                    <span className="text-[11px] text-muted-foreground">
                      added {formatDate(card.created_at)}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-border/60 md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-secondary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Card</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Name on card</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((card) => {
                  const exp = expiryTone(card);
                  return (
                    <tr key={card.id} className="hover:bg-secondary/30">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5 font-mono text-xs font-semibold">
                          {card.label}
                          {card.is_default && (
                            <Star
                              className="h-3.5 w-3.5 shrink-0 fill-warning text-warning"
                              title="Default method for this account"
                            />
                          )}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {humanize(card.funding)} {humanize(card.type)}
                        </span>
                      </td>
                      <td className="max-w-[220px] px-4 py-3">
                        <AccountCell
                          workspaceName={card.workspace_name}
                          email={card.user_email}
                          userId={card.user_id}
                        />
                      </td>
                      <td className="max-w-[160px] px-4 py-3 text-muted-foreground">
                        <span className="block truncate">
                          {card.billing_name || "—"}
                          {card.billing_country ? (
                            <span className="text-[11px]"> · {card.billing_country}</span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-4 py-3">{humanize(card.provider)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="tabular-nums">{card.expiry_label}</span>
                          {exp.tone && <ToneBadge label={exp.label} tone={exp.tone} />}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <ToneBadge
                          label={humanize(card.status)}
                          tone={card.status === "active" ? "success" : "neutral"}
                        />
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {formatDate(card.created_at)}
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
            total={data?.total ?? 0}
            noun="cards"
            onPage={setPage}
          />
        </>
      )}

      <p className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Cards are removed by the customer from their own billing page, or by the provider when
        they expire. There is no delete here — an operator removing a card would break a renewal
        with no record of who did it.
      </p>
    </>
  );
}
