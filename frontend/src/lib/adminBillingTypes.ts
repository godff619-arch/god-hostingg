// Types for the `/api/admin` money endpoints (backend `routes/adminBilling.ts`).
//
// Kept out of `adminTypes.ts` for the same reason the router is its own file: this
// is a large, self-contained contract, and the billing pages are the only ones
// that read it.
//
// Two conventions worth knowing before reading further:
//   • Every amount arrives twice — `*_cents` (integer, for maths and sorting) and
//     `*_label` (already formatted with the right currency). The label is what the
//     UI prints; a client that re-formats cents will eventually disagree with the
//     invoice it is describing.
//   • Card data is masked server-side (`label: "Visa •••• 7411"`). There is no PAN
//     and no CVV in this file because there is none in the database (§6).

/** The seven account keys every money row carries (backend `accountOf`). */
export interface BillingAccount {
  workspace_id: string | null;
  workspace_name: string | null;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  user_status: string | null;
  billing_email: string | null;
}

export interface Facet {
  key: string;
  count: number;
}

export interface PlanFacet {
  key: string;
  name: string;
}

// ── §37 subscriptions ────────────────────────────────────────────────────────
// `plan_key` is what the account is *sold*; `effective_plan` is what it actually
// gets right now. They diverge when a paid period lapses or a payment fails, and
// reporting both is the entire point of the split — `entitlement_matches_plan`
// false is the row an operator has to look at.

export interface SubscriptionRow extends BillingAccount {
  plan_key: string;
  plan_name: string;
  effective_plan: string;
  effective_plan_name: string;
  entitlement_matches_plan: boolean;
  subscription_status: string;
  payment_status: string;
  billing_provider: string;
  subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  live: boolean;
  manual_override: boolean;
  manual_override_by: string | null;
  manual_override_reason: string | null;
  manual_override_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface SubscriptionsResponse {
  subscriptions: SubscriptionRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    statuses: Facet[];
    providers: Facet[];
    plans: PlanFacet[];
  };
}

export interface SubscriptionEventRow {
  id: string;
  event: string;
  source: string;
  from_plan: string | null;
  to_plan: string | null;
  admin_id: string | null;
  reason: string | null;
  payment_id: string | null;
  created_at: string;
  before: unknown;
  after: unknown;
}

export interface SubscriptionPeriodRow {
  id: string;
  plan_key: string | null;
  plan_name: string | null;
  status: string;
  source: string;
  provider: string;
  interval: string;
  amount_cents: number;
  amount_label: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  manual_override: boolean;
  created_at: string;
}

/** `GET /subscriptions/:workspaceId` — one account's whole billing picture (§8). */
export interface SubscriptionDetail {
  subscription: SubscriptionRow;
  events: SubscriptionEventRow[];
  payments: PaymentRow[];
  invoices: InvoiceRow[];
  payment_methods: CardRow[];
  credit: { balance_cents: number; balance_label: string };
  periods: SubscriptionPeriodRow[];
}

// ── §10 payments and refunds ─────────────────────────────────────────────────

export interface RefundRow {
  id: string;
  amount_cents: number;
  amount_label: string;
  status: string;
  reason: string | null;
  admin_id: string | null;
  created_at: string;
  settled_at: string | null;
}

/**
 * `GET /refunds` — the same refund seen from the ledger rather than from inside a
 * payment, so it carries the account and the charge it came out of. `admin_email`
 * is resolved server-side: a refund with no operator is one the provider reported.
 */
export interface RefundLedgerRow extends BillingAccount, RefundRow {
  payment_id: string;
  provider: string;
  provider_ref: string | null;
  currency: string;
  admin_email: string | null;
  /** The original charge, so a partial refund can be read as a proportion. */
  payment_amount_cents: number | null;
  plan_key: string | null;
}

export interface RefundsResponse {
  refunds: RefundLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Summed in SQL over the whole filtered set, succeeded refunds only. */
  totals: {
    refunded_cents: number;
    refunded_label: string;
  };
}

export interface PaymentRow extends BillingAccount {
  id: string;
  provider: string;
  /** The provider's own id, so support can match this against their dashboard. */
  provider_ref: string | null;
  status: string;
  amount_cents: number;
  amount_label: string;
  currency: string;
  refunded_cents: number;
  refunded_label: string | null;
  /** What is still refundable — the server does this subtraction, not the client. */
  refundable_cents: number;
  plan_key: string | null;
  kind: string;
  description: string | null;
  failure_code: string | null;
  failure_message: string | null;
  invoice_id: string | null;
  created_at: string;
  succeeded_at: string | null;
  failed_at: string | null;
  refunds: RefundRow[];
}

export interface PaymentsResponse {
  payments: PaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Aggregated in SQL over the whole filtered set, not the visible page. */
  totals: {
    succeeded_count: number;
    collected_cents: number;
    collected_label: string;
    refunded_cents: number;
    refunded_label: string;
    net_cents: number;
    net_label: string;
  };
  facets: { statuses: Facet[] };
}

export interface CheckoutSessionRow {
  id: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  plan_key: string | null;
  amount_cents: number;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface PaymentDetail {
  payment: PaymentRow;
  invoice: InvoiceRow | null;
  checkout_session: CheckoutSessionRow | null;
  subscription_events: SubscriptionEventRow[];
  /** The verified provider payload, shown as-is for forensics. */
  provider_event: unknown;
}

// ── §11 invoices ─────────────────────────────────────────────────────────────

export interface InvoiceItemRow {
  id: string;
  description: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
  amount_label: string;
  kind: string;
}

export interface InvoiceRow extends BillingAccount {
  id: string;
  number: string;
  period_start: string | null;
  period_end: string | null;
  amount_cents: number;
  amount_label: string;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  credit_cents: number;
  currency: string;
  status: string;
  issued_at: string | null;
  paid_at: string | null;
  due_at: string | null;
  payment_id: string | null;
  notes: string | null;
  /** NULL until a PDF renderer exists — the download endpoint serves text. */
  pdf_path: string | null;
  voided_at: string | null;
  voided_by: string | null;
  /** Set only when an admin settled it outside the provider (§11). */
  marked_paid_by: string | null;
  marked_paid_reason: string | null;
  sent_count: number;
  last_sent_at: string | null;
  items?: InvoiceItemRow[];
}

export interface InvoicesResponse {
  invoices: InvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: {
    paid_cents: number;
    paid_label: string;
    outstanding_cents: number;
    outstanding_label: string;
  };
  facets: { statuses: Facet[] };
}

/** The registered billing address, used as the invoice's "bill to". */
export interface BillingProfile {
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  vat_id: string | null;
}

/** `GET /invoices/:id` — the document, the charge that settled it, the address. */
export interface InvoiceDetail {
  invoice: InvoiceRow;
  payment: PaymentRow | null;
  billing_profile: BillingProfile | null;
}

// ── §6 cards ─────────────────────────────────────────────────────────────────
// The mask is built server-side (`label`), and the API states what it refuses to
// hold in `never_stored`. There is no field here for a card number because there
// is nowhere for one to come from.

export interface CardRow {
  id: string;
  provider: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
  status: string;
  type: string;
  funding: string;
  billing_name: string | null;
  billing_country: string | null;
  created_at: string;
  /** e.g. `Visa •••• 7411`. */
  label: string;
  /** e.g. `04/29`. */
  expiry_label: string;
  workspace_id?: string | null;
}

export type CardListRow = CardRow & BillingAccount;

export interface CardsResponse {
  cards: CardListRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: { brands: Facet[] };
  never_stored: string[];
}

// ── §13 credits ──────────────────────────────────────────────────────────────
// Signed cents: positive grants, negative revokes. `balance_after` is written by
// the same transaction that moves the balance, so the ledger can be replayed.

export interface CreditTransactionRow extends BillingAccount {
  id: string;
  amount_cents: number;
  amount_label: string;
  kind: string;
  reason: string | null;
  admin_id: string | null;
  admin_email: string | null;
  balance_after: number;
  balance_after_label: string;
  created_at: string;
}

export interface CreditBalanceRow extends BillingAccount {
  balance_cents: number;
  balance_label: string;
  updated_at: string;
}

export interface CreditsResponse {
  transactions: CreditTransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Total unspent credit — the liability finance asks about. */
  outstanding_cents: number;
  outstanding_label: string;
  top_balances: CreditBalanceRow[];
  kinds: string[];
}

// ── §13 coupons ──────────────────────────────────────────────────────────────

export type CouponKind = "fixed" | "percent";
export type CouponDuration = "once" | "forever" | "months";
export type CouponState = "active" | "disabled" | "expired" | "scheduled" | "exhausted";

export interface CouponRow {
  id: string;
  code: string;
  kind: string;
  amount_cents: number;
  amount_label: string;
  percent_off: number | null;
  /** `20% off` or `$5.00 off`, whichever the kind means. */
  value_label: string;
  description: string | null;
  /** Empty ⇒ valid on every plan. */
  plan_keys: string[];
  duration: string;
  duration_months: number | null;
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  max_redemables: number | null;
  redemption_count: number;
  created_by: string | null;
  created_at: string;
  /** Derived server-side so every surface agrees on what "usable" means. */
  usable: boolean;
  state: string;
}

export interface CouponsResponse {
  coupons: CouponRow[];
  total: number;
  page: number;
  pageSize: number;
  kinds: string[];
  durations: string[];
  plans: PlanFacet[];
}

export interface RedemptionRow extends BillingAccount {
  id: string;
  redeemed_at: string;
}

export interface RedemptionsResponse {
  redemptions: RedemptionRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── §58 the user detail Billing tab ──────────────────────────────────────────

export interface OpenCheckoutRow {
  id: string;
  workspace_id: string;
  plan_key: string | null;
  amount_cents: number;
  amount_label: string;
  provider: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export interface UserBillingResponse {
  user: {
    id: string;
    name: string | null;
    email: string;
    status: string;
    plan: { key: string; name: string } | null;
  };
  /** An account can own several workspaces; billing follows ownership. */
  workspaces: Array<SubscriptionRow & { card_count: number }>;
  payments: PaymentRow[];
  invoices: InvoiceRow[];
  payment_methods: CardRow[];
  credit: {
    balance_cents: number;
    balance_label: string;
    transactions: Array<Omit<CreditTransactionRow, keyof BillingAccount | "balance_after_label" | "amount_label"> & {
      workspace_id: string;
      amount_label: string;
    }>;
  };
  events: SubscriptionEventRow[];
  /** An open session explains "they clicked upgrade and nothing happened". */
  open_checkouts: OpenCheckoutRow[];
  never_stored: string[];
}

// ── §44 billing analytics ────────────────────────────────────────────────────
// Every figure here is derived from rows. Comped (manually granted) value is
// reported beside MRR and never inside it, so the revenue number stays honest.

export interface BillingAnalytics {
  range: { days: number; from: string; to: string };
  recurring: {
    mrr_cents: number;
    mrr_label: string;
    arr_cents: number;
    arr_label: string;
    arpa_cents: number;
    paying_accounts: number;
    comped_mrr_cents: number;
    comped_mrr_label: string;
    comped_accounts: number;
  };
  collected: {
    today_cents: number;
    today_label: string;
    month_cents: number;
    month_label: string;
    range_cents: number;
    range_label: string;
  };
  health: {
    churn_rate: number;
    churned_in_range: number;
    activated_in_range: number;
    conversion_rate: number;
    total_accounts: number;
    payment_success_rate: number;
    payments_attempted: number;
    failed_payments: number;
    pending_payments: number;
    open_checkouts: number;
    credit_liability_cents: number;
    credit_liability_label: string;
  };
  revenue_by_month: Array<{ month: string; revenue_cents: number; payments: number }>;
  plan_distribution: Array<{ key: string; name: string; count: number; monthly_price_cents: number }>;
  payment_statuses: Facet[];
  top_accounts: Array<BillingAccount & { revenue_cents: number; revenue_label: string }>;
}

