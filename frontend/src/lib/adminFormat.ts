// Display helpers shared by every admin money page.
//
// The backend already renders the money strings (`amount_label`, `paid_label`…)
// because a client that formats cents itself will eventually disagree with the
// invoice. These helpers cover what is left: dates, relative time, and mapping a
// billing status onto the semantic tone families the badges use.

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** `12 Mar 2026` — the table form. Empty for a missing date, never "Invalid Date". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** `12 Mar 2026, 14:05` — detail panes, where the hour matters for support. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatDate(iso)}, ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** `in 12 days` / `6 days ago` / `today`. Used for period ends and card expiry. */
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/** True when the date is in the past. Drives the "lapsed period" warnings. */
export function isPast(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

/** `past_due` → `Past due`. Statuses are snake_case on the wire, prose on screen. */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Tone for a billing status. One table for every money surface, so `failed` is the
 * same red on payments, invoices and subscriptions — an operator should not have
 * to relearn the colours per page.
 */
const TONES: Record<string, Tone> = {
  // Subscriptions
  active: "success",
  trialing: "info",
  past_due: "warning",
  unpaid: "danger",
  canceled: "neutral",
  cancelled: "neutral",
  expired: "neutral",
  none: "neutral",
  // Payments
  succeeded: "success",
  pending: "warning",
  processing: "warning",
  failed: "danger",
  refunded: "neutral",
  partially_refunded: "warning",
  disputed: "danger",
  // Invoices
  paid: "success",
  draft: "neutral",
  open: "info",
  void: "neutral",
  uncollectible: "danger",
  // Cards / accounts
  valid: "success",
  suspended: "danger",
  requires_action: "warning",
};

export function billingTone(status: string | null | undefined): Tone {
  if (!status) return "neutral";
  return TONES[status.toLowerCase()] ?? "neutral";
}

/**
 * Cents → a plain string, for the few places that have no server label (a form
 * default, a locally-computed remainder). Anything shown as an authoritative
 * figure should use the server's `*_label` instead.
 */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

/** The inverse, for submitting a money field. Returns null when unparseable. */
export function inputToCents(value: string): number | null {
  const n = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
