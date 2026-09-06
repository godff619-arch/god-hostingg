// Who redeemed a coupon — §13.
//
// `PromoRedemption` has no workspace relation, so the server resolves the accounts
// in a second query and hands back the same seven account keys every money row
// carries. That is all a redemption is: an account and a moment. There is no
// "un-redeem" action because the discount has already been applied to an invoice —
// reversing it means refunding that invoice, from the Payments page.

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import {
  AccountCell,
  ListEmpty,
  ListError,
  ListSkeleton,
  Pagination,
} from "@/components/admin/AdminList";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminGet } from "@/lib/adminApi";
import type { CouponRow, RedemptionRow, RedemptionsResponse } from "@/lib/adminBillingTypes";
import { formatDateTime } from "@/lib/adminFormat";

const PAGE_SIZE = 15;

export function CouponRedemptionsDialog({
  coupon,
  onClose,
}: {
  coupon: CouponRow | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<RedemptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [coupon?.id]);

  const load = useCallback(async () => {
    if (!coupon) return;
    setLoading(true);
    try {
      const res = await adminGet<RedemptionsResponse>(
        `/coupons/${coupon.id}/redemptions?page=${page}&pageSize=${PAGE_SIZE}`,
      );
      setRows(res.redemptions);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load redemptions");
    } finally {
      setLoading(false);
    }
  }, [coupon, page]);

  useEffect(() => {
    load();
  }, [load]);

  if (!coupon) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary">
            <Users className="h-6 w-6 text-muted-foreground" />
          </div>
          <DialogTitle className="text-center font-mono">{coupon.code}</DialogTitle>
          <DialogDescription className="text-center">
            {coupon.redemption_count === 0
              ? "Nobody has used this coupon yet."
              : `${coupon.redemption_count} redemption${coupon.redemption_count === 1 ? "" : "s"}${
                  coupon.max_redemables ? ` of ${coupon.max_redemables} allowed` : " — no limit set"
                }.`}
          </DialogDescription>
        </DialogHeader>

        {error && <ListError message={error} onRetry={load} />}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : rows.length === 0 ? (
          <ListEmpty
            message="No redemptions recorded."
            hint="A row lands here the moment the code is accepted at checkout."
          />
        ) : (
          <>
            <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <AccountCell
                    workspaceName={r.workspace_name}
                    email={r.user_email}
                    userId={r.user_id}
                  />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(r.redeemed_at)}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              noun="redemptions"
              onPage={setPage}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
