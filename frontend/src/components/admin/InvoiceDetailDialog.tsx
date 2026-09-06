// One invoice, with the three §11 actions that act on it.
//
// The actions live in here rather than on the list row because each of them needs
// something the row cannot show: void needs the current status (a paid invoice
// must be refunded, not voided), mark-paid needs a confirmation plus a reason and
// a plain statement that no plan will move, and send needs the recipient address
// it is about to use.
//
// What the server refuses, this dialog does not offer:
//   • `void` on a paid invoice → 409 ALREADY_PAID. The button is replaced by copy
//     pointing at the refund flow.
//   • `mark-paid` on a void invoice → 409 VOIDED.
//   • `send` on a void invoice → 409 VOIDED.
//
// Mark-paid is the sharpest edge in here. It settles the *document* only: no
// Payment row is created and no subscription changes (§34, §59). The server says
// so in its response message and the confirmation copy says so before you click.

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, FileText, Loader2, Mail, Ban } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DetailRow, Field, ListError, ToneBadge } from "@/components/admin/AdminList";
import { adminDownload, adminGet, adminSend } from "@/lib/adminApi";
import type { InvoiceDetail } from "@/lib/adminBillingTypes";
import { billingTone, formatDate, formatDateTime, humanize } from "@/lib/adminFormat";

type Pending = "void" | "mark-paid" | "send" | null;

interface Props {
  invoiceId: string | null;
  onClose: () => void;
  onDone: () => void;
  /** `invoices.manage`; without it the dialog is read-only. */
  mayManage: boolean;
}

export function InvoiceDetailDialog({ invoiceId, onClose, onDone, mayManage }: Props) {
  const [data, setData] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [recipient, setRecipient] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    try {
      const res = await adminGet<InvoiceDetail>(`/invoices/${invoiceId}`);
      setData(res);
      setRecipient(res.invoice.billing_email ?? res.invoice.user_email ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the invoice.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    setData(null);
    setPending(null);
    setReason("");
    load();
  }, [load]);

  if (!invoiceId) return null;
  const inv = data?.invoice;

  const download = async () => {
    try {
      await adminDownload(`/invoices/${invoiceId}/download`, `${inv?.number ?? invoiceId}.txt`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed.");
    }
  };

  const run = async () => {
    if (!pending) return;
    if (pending !== "send" && !reason.trim()) {
      toast.error("A reason is required — it goes in the audit log.");
      return;
    }
    setSaving(true);
    try {
      const body =
        pending === "send"
          ? { to: recipient.trim() || undefined }
          : pending === "mark-paid"
            ? { reason, confirm: true }
            : { reason };
      const res = await adminSend<{ message?: string }>(
        `/invoices/${invoiceId}/${pending}`,
        "POST",
        body,
      );
      toast.success(res.message || "Done.");
      setPending(null);
      setReason("");
      await load();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The action failed.");
    } finally {
      setSaving(false);
    }
  };

  const canVoid = inv && inv.status !== "void" && inv.status !== "paid";
  const canMarkPaid = inv && inv.status !== "void" && inv.status !== "paid";
  const canSend = inv && inv.status !== "void";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-brand" />
            {inv?.number ?? "Invoice"}
          </DialogTitle>
          <DialogDescription>
            {inv
              ? `${inv.workspace_name || inv.user_email || inv.workspace_id} · ${inv.amount_label}`
              : invoiceId}
          </DialogDescription>
        </DialogHeader>

        {loading && !inv && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {error && <ListError message={error} onRetry={load} />}

        {inv && (
          <div className="space-y-5">
            <section className="rounded-xl border border-border/60 bg-secondary/30 px-3 py-1">
              <DetailRow label="Status">
                <ToneBadge label={humanize(inv.status)} tone={billingTone(inv.status)} />
              </DetailRow>
              <DetailRow label="Period">
                {inv.period_start || inv.period_end
                  ? `${formatDate(inv.period_start)} – ${formatDate(inv.period_end)}`
                  : "—"}
              </DetailRow>
              <DetailRow label="Issued">{formatDate(inv.issued_at)}</DetailRow>
              <DetailRow label="Due">{formatDate(inv.due_at)}</DetailRow>
              {inv.paid_at && <DetailRow label="Paid">{formatDateTime(inv.paid_at)}</DetailRow>}
              {inv.voided_at && (
                <DetailRow label="Voided">{formatDateTime(inv.voided_at)}</DetailRow>
              )}
              {inv.marked_paid_by && (
                <DetailRow label="Settled by hand">
                  <span className="text-warning">{inv.marked_paid_reason || "no reason given"}</span>
                </DetailRow>
              )}
              <DetailRow label="Sent">
                {inv.sent_count > 0
                  ? `${inv.sent_count}× · last ${formatDateTime(inv.last_sent_at)}`
                  : "never"}
              </DetailRow>
            </section>

            {inv.items && inv.items.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Lines
                </h3>
                <div className="overflow-hidden rounded-xl border border-border/60">
                  <table className="w-full text-left text-xs">
                    <tbody className="divide-y divide-border/40">
                      {inv.items.map((item) => (
                        <tr key={item.id}>
                          <td className="px-3 py-2">{item.description}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            ×{item.quantity}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">
                            {item.amount_label}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="rounded-xl border border-border/60 px-3 py-1">
              <DetailRow label="Subtotal">
                <span className="tabular-nums">{(inv.subtotal_cents / 100).toFixed(2)}</span>
              </DetailRow>
              {inv.discount_cents > 0 && (
                <DetailRow label="Discount">
                  <span className="tabular-nums text-success">
                    −{(inv.discount_cents / 100).toFixed(2)}
                  </span>
                </DetailRow>
              )}
              {inv.credit_cents > 0 && (
                <DetailRow label="Credit applied">
                  <span className="tabular-nums text-success">
                    −{(inv.credit_cents / 100).toFixed(2)}
                  </span>
                </DetailRow>
              )}
              {inv.tax_cents > 0 && (
                <DetailRow label="Tax">
                  <span className="tabular-nums">{(inv.tax_cents / 100).toFixed(2)}</span>
                </DetailRow>
              )}
              <DetailRow label="Total">
                <span className="font-bold tabular-nums">{inv.amount_label}</span>
              </DetailRow>
            </section>

            {data?.billing_profile && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Bill to
                </h3>
                <p className="rounded-xl border border-border/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {[
                    data.billing_profile.company,
                    data.billing_profile.address1,
                    data.billing_profile.address2,
                    [data.billing_profile.city, data.billing_profile.state]
                      .filter(Boolean)
                      .join(", "),
                    data.billing_profile.postal_code,
                    data.billing_profile.country,
                    data.billing_profile.vat_id ? `VAT ${data.billing_profile.vat_id}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No billing address on file."}
                </p>
              </section>
            )}

            {data?.payment && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Settled by
                </h3>
                <div className="rounded-xl border border-border/60 px-3 py-1">
                  <DetailRow label="Payment">
                    <span className="tabular-nums">{data.payment.amount_label}</span>
                  </DetailRow>
                  <DetailRow label="Status">
                    <ToneBadge
                      label={humanize(data.payment.status)}
                      tone={billingTone(data.payment.status)}
                    />
                  </DetailRow>
                  {data.payment.provider_ref && (
                    <DetailRow label={humanize(data.payment.provider)}>
                      <span className="break-all font-mono text-xs">
                        {data.payment.provider_ref}
                      </span>
                    </DetailRow>
                  )}
                </div>
              </section>
            )}

            {inv.notes && (
              <p className="whitespace-pre-line rounded-xl border border-border/60 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                {inv.notes}
              </p>
            )}

            {/* The confirmation strip, shown in place once an action is chosen. */}
            {pending && (
              <section className="space-y-3 rounded-xl border border-warning-border bg-warning-surface p-3">
                <p className="text-xs font-semibold text-warning">
                  {pending === "void" && "Voiding is permanent. A correction is a new invoice, never a re-opened one."}
                  {pending === "mark-paid" &&
                    "This settles the document only: no payment record is created and the plan does not change."}
                  {pending === "send" && "Queues the invoice email to this address."}
                </p>
                {pending === "send" ? (
                  <Field label="Send to" hint="Defaults to the account's billing email.">
                    <Input
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="billing@example.com"
                    />
                  </Field>
                ) : (
                  <Field label="Reason (required)" hint="Stored in the audit log (§24).">
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                  </Field>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={saving}>
                    Back
                  </Button>
                  <Button
                    size="sm"
                    variant={pending === "void" ? "destructive" : "default"}
                    onClick={run}
                    disabled={saving || (pending !== "send" && !reason.trim())}
                  >
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {pending === "void" && "Void invoice"}
                    {pending === "mark-paid" && "Mark paid"}
                    {pending === "send" && "Queue email"}
                  </Button>
                </div>
              </section>
            )}

            {inv.status === "paid" && mayManage && !pending && (
              <p className="text-xs text-muted-foreground">
                A paid invoice cannot be voided — refund the payment instead, from the
                Payments page.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap">
          <Button variant="outline" className="border-border/60" onClick={download}>
            <Download className="h-4 w-4" /> Download
          </Button>
          {mayManage && !pending && (
            <>
              {canSend && (
                <Button variant="outline" className="border-border/60" onClick={() => setPending("send")}>
                  <Mail className="h-4 w-4" /> Send
                </Button>
              )}
              {canMarkPaid && (
                <Button variant="outline" className="border-border/60" onClick={() => setPending("mark-paid")}>
                  <CheckCircle2 className="h-4 w-4" /> Mark paid
                </Button>
              )}
              {canVoid && (
                <Button variant="outline" className="border-border/60" onClick={() => setPending("void")}>
                  <Ban className="h-4 w-4" /> Void
                </Button>
              )}
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
