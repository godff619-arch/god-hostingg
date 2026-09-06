/**
 * Billing state machine — the ONLY code path that may grant a paid plan.
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * `PATCH /api/billing/plan` used to do:
 *
 *     if (paid && (await prisma.paymentMethod.count(...)) > 0) → set plan_key
 *
 * i.e. once any card existed, every paid tier was free forever. No Payment row, no
 * charge, no invoice. Spec §7/§57 name this exactly: "USER ADDS CARD → PLAN
 * CHANGES IMMEDIATELY → NO PAYMENT IS ACTUALLY CHARGED / THIS MUST NEVER HAPPEN."
 *
 * THE INVARIANT
 * -------------
 * `plan_key` moves to a paid tier through exactly two doors, and both leave
 * evidence:
 *
 *   1. `activateFromPayment()` — a Payment row that a *signature-verified* provider
 *      webhook moved to `succeeded`, whose amount and plan match what checkout
 *      recorded server-side.
 *   2. `manualOverride()` — an admin decision carrying actor + reason + timestamp,
 *      flagged `manual_override = true` so it is never mistaken for a payment.
 *
 * Both write a `SubscriptionEvent` with before/after snapshots. Nothing else in the
 * codebase writes `plan_key` to a paid value; `grep -n "plan_key" src/` should stay
 * boring.
 *
 * WHY `effectivePlanKey()` EXISTS
 * ------------------------------
 * §37 forbids treating one `plan` field as the source of truth. `plan_key` is the
 * entitlement, `subscription_status` says whether it is still live. A canceled or
 * expired subscription leaves `plan_key` alone (so the admin panel and the renewal
 * flow can still see what it was) while `effectivePlanKey()` reports `hobby`.
 * Quota enforcement asks that function, never the raw column.
 */
import type { Prisma, Workspace } from '@prisma/client';
import prisma from './prisma.js';
import { issueInvoice } from './invoices.js';

/** Free tier key. The only plan any account gets without a payment. */
export const FREE_PLAN_KEY = 'hobby';

/** Statuses in which a paid `plan_key` is actually honoured. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * `past_due` is deliberately live: dunning should retry before revoking, and
 * yanking a customer's apps offline the minute a renewal card blips is worse than
 * carrying them for a cycle. Revocation happens when the status reaches `expired`
 * or `canceled`.
 */
export function isLiveSubscription(status: string | null | undefined): boolean {
  return LIVE_STATUSES.has(status ?? 'none');
}

/** Billing-state fields, the subset the state machine reads and snapshots. */
export type BillingState = Pick<
  Workspace,
  | 'plan_key'
  | 'subscription_status'
  | 'payment_status'
  | 'billing_provider'
  | 'subscription_id'
  | 'current_period_start'
  | 'current_period_end'
  | 'cancel_at_period_end'
  | 'manual_override'
  | 'manual_override_by'
  | 'manual_override_reason'
  | 'manual_override_at'
>;

export const BILLING_STATE_SELECT = {
  plan_key: true,
  subscription_status: true,
  payment_status: true,
  billing_provider: true,
  subscription_id: true,
  current_period_start: true,
  current_period_end: true,
  cancel_at_period_end: true,
  manual_override: true,
  manual_override_by: true,
  manual_override_reason: true,
  manual_override_at: true,
} as const;

/**
 * The plan the workspace is actually entitled to right now. Paid `plan_key` with a
 * dead subscription reads as free — this is what quota enforcement must call.
 */
export function effectivePlanKey(ws: {
  plan_key: string;
  subscription_status: string;
  current_period_end?: Date | null;
}): string {
  if (ws.plan_key === FREE_PLAN_KEY) return FREE_PLAN_KEY;
  if (!isLiveSubscription(ws.subscription_status)) return FREE_PLAN_KEY;
  // A period that ended and was never renewed is lapsed regardless of what the
  // status column still claims — a missed cron run must not hand out free Pro.
  if (ws.current_period_end && ws.current_period_end.getTime() < Date.now()) {
    return FREE_PLAN_KEY;
  }
  return ws.plan_key;
}

/** Tier ordering, for upgrade/downgrade classification in the event ledger. */
const PLAN_RANK: Record<string, number> = { hobby: 0, free: 0, pro: 1, premium: 1, scale: 2 };

export function planRank(key: string | null | undefined): number {
  return PLAN_RANK[(key ?? '').toLowerCase()] ?? 1;
}

export function isPaidPlan(key: string | null | undefined): boolean {
  return Boolean(key) && key !== FREE_PLAN_KEY && key !== 'free';
}

/** Classify a plan move for the `SubscriptionEvent.event` column. */
function transitionEvent(from: string, to: string): string {
  if (from === to) return 'renewed';
  return planRank(to) > planRank(from) ? 'upgraded' : 'downgraded';
}

// ── The event ledger ───────────────────────────────────────────────────────

export interface SubscriptionEventInput {
  workspace_id: string;
  event: string;
  source?: 'webhook' | 'admin' | 'system' | 'user';
  from_plan?: string | null;
  to_plan?: string | null;
  admin_id?: string | null;
  reason?: string | null;
  payment_id?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Append to the immutable subscription ledger. Best-effort by design: a ledger
 * write failing must not roll back a payment that the provider already took.
 * The gap is visible (payment with no event) rather than silent.
 */
export async function writeSubscriptionEvent(input: SubscriptionEventInput): Promise<void> {
  try {
    await prisma.subscriptionEvent.create({
      data: {
        workspace_id: input.workspace_id,
        event: input.event,
        source: input.source ?? 'system',
        from_plan: input.from_plan ?? null,
        to_plan: input.to_plan ?? null,
        admin_id: input.admin_id ?? null,
        reason: input.reason ?? null,
        payment_id: input.payment_id ?? null,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.warn('[billing] subscription event write failed:', err);
  }
}

// ── Activation ─────────────────────────────────────────────────────────────

/** Add one billing interval to a date. `lifetime` returns null (never expires). */
export function periodEndFor(start: Date, interval: string): Date | null {
  const d = new Date(start);
  if (interval === 'year') {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  }
  if (interval === 'lifetime') return null;
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export interface ActivationResult {
  ok: boolean;
  /** Why activation was refused. Recorded on the webhook event row. */
  detail?: string;
  workspace_id?: string;
  plan_key?: string;
  invoice_id?: string;
  /** True when the payment was already applied — a replay, answered idempotently. */
  duplicate?: boolean;
}

export interface ActivateArgs {
  /** Payment row id. Must already be `succeeded` or be flipped by this call. */
  payment_id: string;
  source: 'webhook' | 'admin' | 'system';
  /** Provider-reported amount, checked against the payment we recorded. */
  observed_amount_cents?: number | null;
  observed_currency?: string | null;
  /** Provider's own ids, stored for forensics. */
  provider_ref?: string | null;
  provider_event?: unknown;
  period_start?: Date | null;
  period_end?: Date | null;
  /** Set for `source = admin` (offline payment confirmation). */
  admin_id?: string | null;
  reason?: string | null;
}

/**
 * Apply a successful payment: mark it `succeeded`, move the workspace onto the plan
 * the payment bought, issue the invoice, append the ledger event.
 *
 * Every guard here answers a specific §34 requirement:
 *
 *   - already `succeeded`        → duplicate webhook, return ok+duplicate, no writes
 *   - amount/currency mismatch   → refuse; a tampered payload cannot buy a plan
 *   - unknown payment            → refuse; a forged event has nothing to point at
 *   - `plan_key` from the *payment row*, never from the event body
 *
 * Runs in one transaction so a workspace is never left on a paid plan without the
 * payment and invoice that justify it.
 */
export async function activateFromPayment(args: ActivateArgs): Promise<ActivationResult> {
  const payment = await prisma.payment.findUnique({ where: { id: args.payment_id } });
  if (!payment) return { ok: false, detail: 'payment not found' };

  // Idempotency (§34): the fifth delivery of the same charge must not re-activate,
  // re-invoice, or re-emit an event. It is not an error either — the provider is
  // told 200 so it stops retrying.
  if (payment.status === 'succeeded') {
    return {
      ok: true,
      duplicate: true,
      workspace_id: payment.workspace_id,
      plan_key: payment.plan_key ?? undefined,
      detail: 'payment already applied',
    };
  }
  if (payment.status === 'refunded' || payment.status === 'canceled') {
    return { ok: false, detail: `payment is ${payment.status}` };
  }

  // Amount verification (§34 "Verify: Payment ID, Amount, Currency"). The number
  // that matters is the one recorded when checkout was created server-side.
  if (args.observed_amount_cents != null && args.observed_amount_cents !== payment.amount_cents) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'failed',
        failure_code: 'amount_mismatch',
        failure_message: `Provider reported ${args.observed_amount_cents}, expected ${payment.amount_cents}`,
        failed_at: new Date(),
      },
    });
    return {
      ok: false,
      detail: `amount mismatch: got ${args.observed_amount_cents}, expected ${payment.amount_cents}`,
    };
  }
  if (
    args.observed_currency &&
    args.observed_currency.toUpperCase() !== payment.currency.toUpperCase()
  ) {
    return {
      ok: false,
      detail: `currency mismatch: got ${args.observed_currency}, expected ${payment.currency}`,
    };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: payment.workspace_id },
    select: { id: true, name: true, email: true, owner_id: true, ...BILLING_STATE_SELECT },
  });
  if (!workspace) return { ok: false, detail: 'workspace not found' };

  const planKey = payment.plan_key ?? workspace.plan_key;
  const plan = await prisma.plan.findUnique({ where: { key: planKey } });
  const interval = plan?.interval ?? 'month';
  const now = new Date();
  const periodStart = args.period_start ?? now;
  const periodEnd = args.period_end ?? periodEndFor(periodStart, interval);

  const before: BillingState = {
    plan_key: workspace.plan_key,
    subscription_status: workspace.subscription_status,
    payment_status: workspace.payment_status,
    billing_provider: workspace.billing_provider,
    subscription_id: workspace.subscription_id,
    current_period_start: workspace.current_period_start,
    current_period_end: workspace.current_period_end,
    cancel_at_period_end: workspace.cancel_at_period_end,
    manual_override: workspace.manual_override,
    manual_override_by: workspace.manual_override_by,
    manual_override_reason: workspace.manual_override_reason,
    manual_override_at: workspace.manual_override_at,
  };

  const invoice = await issueInvoice({
    workspace_id: workspace.id,
    currency: payment.currency,
    status: 'paid',
    payment_id: payment.id,
    period_start: periodStart,
    period_end: periodEnd ?? new Date(periodStart.getTime() + 30 * 86_400_000),
    lines: [
      {
        description: `${plan?.name ?? planKey} plan — ${interval === 'year' ? 'annual' : 'monthly'}`,
        unit_cents: payment.amount_cents,
        kind: 'plan',
      },
    ],
    notes:
      args.source === 'admin'
        ? `Offline payment confirmed by an operator. ${args.reason ?? ''}`.trim()
        : null,
  });

  const after = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'succeeded',
        succeeded_at: now,
        provider_ref: args.provider_ref ?? payment.provider_ref,
        provider_event: (args.provider_event ?? undefined) as Prisma.InputJsonValue | undefined,
        invoice_id: invoice.id,
        failure_code: null,
        failure_message: null,
      },
    });

    const updated = await tx.workspace.update({
      where: { id: workspace.id },
      data: {
        plan_key: planKey,
        subscription_status: 'active',
        payment_status: 'paid',
        billing_provider: payment.provider,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        // A real payment clears any prior manual override: the account is now paid
        // for, and leaving the flag set would mislabel it forever.
        manual_override: false,
        manual_override_by: null,
        manual_override_reason: null,
        manual_override_at: null,
      },
      select: BILLING_STATE_SELECT,
    });

    // Mirror onto the historical Subscription row so existing reads (User.plan_id
    // fast path, billing history) stay coherent.
    if (plan) {
      await tx.subscription.updateMany({
        where: { workspace_id: workspace.id, status: { in: ['active', 'trialing', 'past_due'] } },
        data: { status: 'canceled', canceled_at: now, cancel_reason: 'replaced by new subscription' },
      });
      await tx.subscription.create({
        data: {
          user_id: workspace.owner_id,
          plan_id: plan.id,
          workspace_id: workspace.id,
          status: 'active',
          source: args.source === 'admin' ? 'manual' : 'webhook',
          provider: payment.provider,
          provider_ref: args.provider_ref ?? payment.provider_ref,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          expires_at: periodEnd,
          interval,
          amount_cents: payment.amount_cents,
          currency: payment.currency,
          manual_override: false,
        },
      });
      // Quota enforcement reads User.plan_id; keep the owner's fast path in sync.
      await tx.user.update({ where: { id: workspace.owner_id }, data: { plan_id: plan.id } });
    }

    await tx.checkoutSession.updateMany({
      where: { payment_id: payment.id, status: 'open' },
      data: { status: 'completed', completed_at: now },
    });

    return updated;
  });

  await writeSubscriptionEvent({
    workspace_id: workspace.id,
    event: before.plan_key === planKey ? 'renewed' : transitionEvent(before.plan_key, planKey),
    source: args.source,
    from_plan: before.plan_key,
    to_plan: planKey,
    admin_id: args.admin_id ?? null,
    reason: args.reason ?? null,
    payment_id: payment.id,
    before,
    after,
  });

  return { ok: true, workspace_id: workspace.id, plan_key: planKey, invoice_id: invoice.id };
}

// ── Failure ────────────────────────────────────────────────────────────────

/**
 * A payment failed at the provider. §35: the plan does NOT change, the previous
 * plan stays, the attempt is recorded so the user can retry.
 */
export async function recordFailure(args: {
  payment_id: string;
  code?: string | null;
  message?: string | null;
  provider_event?: unknown;
}): Promise<ActivationResult> {
  const payment = await prisma.payment.findUnique({ where: { id: args.payment_id } });
  if (!payment) return { ok: false, detail: 'payment not found' };
  if (payment.status === 'succeeded') {
    // Out-of-order delivery: a `failed` event arriving after the charge already
    // succeeded must not revoke a paid plan.
    return { ok: false, detail: 'payment already succeeded; failure event ignored' };
  }

  const now = new Date();
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'failed',
      failed_at: now,
      failure_code: args.code ?? 'provider_declined',
      failure_message: args.message ?? 'The payment was declined by the provider.',
      provider_event: (args.provider_event ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });

  const ws = await prisma.workspace.findUnique({
    where: { id: payment.workspace_id },
    select: { plan_key: true, subscription_status: true, payment_status: true },
  });

  // Only the *payment* status moves. `plan_key` and `subscription_status` are
  // untouched — an upgrade attempt that fails leaves the customer where they were.
  await prisma.workspace.update({
    where: { id: payment.workspace_id },
    data: { payment_status: 'failed' },
  });

  await prisma.checkoutSession.updateMany({
    where: { payment_id: payment.id, status: 'open' },
    data: { status: 'canceled' },
  });

  await writeSubscriptionEvent({
    workspace_id: payment.workspace_id,
    event: 'payment_failed',
    source: 'webhook',
    from_plan: ws?.plan_key ?? null,
    to_plan: ws?.plan_key ?? null,
    payment_id: payment.id,
    reason: args.message ?? 'payment failed',
    before: ws ?? undefined,
    after: { ...(ws ?? {}), payment_status: 'failed' },
  });

  return { ok: true, workspace_id: payment.workspace_id, detail: 'failure recorded' };
}

// ── Manual override (§36, §59) ──────────────────────────────────────────────

/**
 * Admin grants (or removes) a plan without a payment.
 *
 * §59 is explicit: this must NOT fabricate a payment row. It sets the override
 * flags instead, so every report can tell a comped account from a paying one, and
 * the reason is mandatory at the type level rather than by convention.
 */
export async function manualOverride(args: {
  workspace_id: string;
  plan_key: string;
  admin_id: string;
  admin_email?: string | null;
  reason: string;
  /** Optional expiry; after this the account lapses to free. NULL = indefinite. */
  expires_at?: Date | null;
}): Promise<ActivationResult> {
  const reason = args.reason?.trim();
  if (!reason) return { ok: false, detail: 'a reason is required for a manual plan change' };

  const workspace = await prisma.workspace.findUnique({
    where: { id: args.workspace_id },
    select: { id: true, owner_id: true, ...BILLING_STATE_SELECT },
  });
  if (!workspace) return { ok: false, detail: 'workspace not found' };

  const plan = await prisma.plan.findUnique({ where: { key: args.plan_key } });
  if (!plan) return { ok: false, detail: `unknown plan "${args.plan_key}"` };

  const before: BillingState = { ...workspace };
  const now = new Date();
  const paid = isPaidPlan(args.plan_key);

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.workspace.update({
      where: { id: workspace.id },
      data: {
        plan_key: args.plan_key,
        subscription_status: paid ? 'active' : 'none',
        // NOT `paid`: no money moved. This is the field that keeps an override
        // honest in every revenue report.
        payment_status: 'none',
        billing_provider: 'manual',
        current_period_start: paid ? now : null,
        current_period_end: paid ? (args.expires_at ?? null) : null,
        cancel_at_period_end: false,
        manual_override: paid,
        manual_override_by: paid ? args.admin_id : null,
        manual_override_reason: paid ? reason : null,
        manual_override_at: paid ? now : null,
      },
      select: BILLING_STATE_SELECT,
    });

    await tx.subscription.updateMany({
      where: { workspace_id: workspace.id, status: { in: ['active', 'trialing', 'past_due'] } },
      data: { status: 'canceled', canceled_at: now, cancel_reason: `manual change: ${reason}` },
    });
    if (paid) {
      await tx.subscription.create({
        data: {
          user_id: workspace.owner_id,
          plan_id: plan.id,
          workspace_id: workspace.id,
          status: 'active',
          source: 'manual',
          provider: 'manual',
          current_period_start: now,
          current_period_end: args.expires_at ?? null,
          expires_at: args.expires_at ?? null,
          interval: plan.interval,
          amount_cents: 0,
          currency: plan.currency,
          manual_override: true,
        },
      });
    }
    await tx.user.update({ where: { id: workspace.owner_id }, data: { plan_id: plan.id } });
    return updated;
  });

  await writeSubscriptionEvent({
    workspace_id: workspace.id,
    event: 'manual_override',
    source: 'admin',
    from_plan: before.plan_key,
    to_plan: args.plan_key,
    admin_id: args.admin_id,
    reason,
    before,
    after,
  });

  return { ok: true, workspace_id: workspace.id, plan_key: args.plan_key };
}

// ── Cancellation + refund ──────────────────────────────────────────────────

/**
 * Cancel a subscription. `at_period_end` keeps the customer on their plan until
 * the period they already paid for runs out — cancelling immediately after taking
 * their money would be theft, so that is the default.
 */
export async function cancelSubscription(args: {
  workspace_id: string;
  at_period_end?: boolean;
  reason?: string | null;
  source?: 'webhook' | 'admin' | 'system' | 'user';
  admin_id?: string | null;
}): Promise<ActivationResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: args.workspace_id },
    select: { id: true, owner_id: true, ...BILLING_STATE_SELECT },
  });
  if (!workspace) return { ok: false, detail: 'workspace not found' };

  const before: BillingState = { ...workspace };
  const now = new Date();
  const atPeriodEnd = args.at_period_end ?? true;
  const immediate = !atPeriodEnd || !workspace.current_period_end;

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.workspace.update({
      where: { id: workspace.id },
      data: immediate
        ? {
            plan_key: FREE_PLAN_KEY,
            subscription_status: 'canceled',
            cancel_at_period_end: false,
            current_period_end: now,
            manual_override: false,
            manual_override_by: null,
            manual_override_reason: null,
            manual_override_at: null,
          }
        : { cancel_at_period_end: true },
      select: BILLING_STATE_SELECT,
    });

    await tx.subscription.updateMany({
      where: { workspace_id: workspace.id, status: { in: ['active', 'trialing', 'past_due'] } },
      data: immediate
        ? { status: 'canceled', canceled_at: now, cancel_reason: args.reason ?? null }
        : { cancel_at_period_end: true, cancel_reason: args.reason ?? null },
    });

    if (immediate) {
      const free = await tx.plan.findFirst({ where: { key: FREE_PLAN_KEY } });
      if (free) await tx.user.update({ where: { id: workspace.owner_id }, data: { plan_id: free.id } });
    }
    return updated;
  });

  await writeSubscriptionEvent({
    workspace_id: workspace.id,
    event: 'canceled',
    source: args.source ?? 'user',
    from_plan: before.plan_key,
    to_plan: immediate ? FREE_PLAN_KEY : before.plan_key,
    admin_id: args.admin_id ?? null,
    reason: args.reason ?? null,
    before,
    after,
  });

  return { ok: true, workspace_id: workspace.id, plan_key: after.plan_key };
}

/**
 * Record a refund against a payment. Full refunds mark the payment `refunded` and
 * the workspace `payment_status = refunded`; partials leave the subscription alone.
 * Whether the plan is also revoked is an operator decision (`revoke_plan`), not an
 * automatic consequence — refunding a month of service mid-cycle is common.
 */
export async function recordRefund(args: {
  payment_id: string;
  amount_cents: number;
  reason: string;
  admin_id?: string | null;
  provider?: string;
  provider_ref?: string | null;
  revoke_plan?: boolean;
}): Promise<ActivationResult & { refund_id?: string }> {
  const reason = args.reason?.trim();
  if (!reason) return { ok: false, detail: 'a reason is required for a refund' };

  const payment = await prisma.payment.findUnique({ where: { id: args.payment_id } });
  if (!payment) return { ok: false, detail: 'payment not found' };
  if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
    return { ok: false, detail: `cannot refund a payment that is ${payment.status}` };
  }

  const remaining = payment.amount_cents - payment.refunded_cents;
  const amount = Math.min(Math.max(1, Math.round(args.amount_cents)), remaining);
  if (remaining <= 0) return { ok: false, detail: 'payment is already fully refunded' };

  const now = new Date();
  const refundedTotal = payment.refunded_cents + amount;
  const full = refundedTotal >= payment.amount_cents;

  const refund = await prisma.$transaction(async (tx) => {
    const created = await tx.refund.create({
      data: {
        payment_id: payment.id,
        provider: args.provider ?? payment.provider,
        provider_ref: args.provider_ref ?? null,
        amount_cents: amount,
        currency: payment.currency,
        status: 'succeeded',
        reason,
        admin_id: args.admin_id ?? null,
        settled_at: now,
      },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refunded_cents: refundedTotal,
        status: full ? 'refunded' : 'partially_refunded',
      },
    });
    await tx.workspace.update({
      where: { id: payment.workspace_id },
      data: { payment_status: full ? 'refunded' : 'partially_refunded' },
    });
    if (payment.invoice_id) {
      await tx.invoice.update({
        where: { id: payment.invoice_id },
        data: { status: full ? 'refunded' : 'paid' },
      });
    }
    return created;
  });

  if (args.revoke_plan) {
    await cancelSubscription({
      workspace_id: payment.workspace_id,
      at_period_end: false,
      reason: `refunded: ${reason}`,
      source: args.admin_id ? 'admin' : 'webhook',
      admin_id: args.admin_id ?? null,
    });
  }

  await writeSubscriptionEvent({
    workspace_id: payment.workspace_id,
    event: 'refunded',
    source: args.admin_id ? 'admin' : 'webhook',
    admin_id: args.admin_id ?? null,
    reason,
    payment_id: payment.id,
    before: { refunded_cents: payment.refunded_cents, status: payment.status },
    after: { refunded_cents: refundedTotal, status: full ? 'refunded' : 'partially_refunded' },
  });

  return { ok: true, workspace_id: payment.workspace_id, refund_id: refund.id };
}

// ── Lapse sweep ────────────────────────────────────────────────────────────

/**
 * Move workspaces whose paid period has ended to `expired`, and honour any
 * `cancel_at_period_end`. Idempotent, so it is safe to call on every boot and on a
 * timer. Returns how many it touched.
 *
 * Without this, `effectivePlanKey()` already refuses to honour a lapsed period, so
 * a missed run degrades to "correct entitlement, stale status column" rather than
 * to free Pro.
 */
export async function sweepLapsedSubscriptions(): Promise<number> {
  const now = new Date();
  const due = await prisma.workspace.findMany({
    where: {
      subscription_status: { in: ['active', 'trialing', 'past_due'] },
      current_period_end: { not: null, lt: now },
    },
    select: { id: true, owner_id: true, ...BILLING_STATE_SELECT },
  });

  for (const ws of due) {
    // A comped account with an expiry lapses the same way a paid one does.
    const before: BillingState = { ...ws };
    const after = await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        plan_key: FREE_PLAN_KEY,
        subscription_status: ws.cancel_at_period_end ? 'canceled' : 'expired',
        cancel_at_period_end: false,
        manual_override: false,
        manual_override_by: null,
        manual_override_reason: null,
        manual_override_at: null,
      },
      select: BILLING_STATE_SELECT,
    });
    await prisma.subscription.updateMany({
      where: { workspace_id: ws.id, status: { in: ['active', 'trialing', 'past_due'] } },
      data: { status: ws.cancel_at_period_end ? 'canceled' : 'past_due', canceled_at: now },
    });
    const free = await prisma.plan.findFirst({ where: { key: FREE_PLAN_KEY } });
    if (free) {
      await prisma.user.update({ where: { id: ws.owner_id }, data: { plan_id: free.id } }).catch(() => {});
    }
    await writeSubscriptionEvent({
      workspace_id: ws.id,
      event: ws.cancel_at_period_end ? 'canceled' : 'expired',
      source: 'system',
      from_plan: before.plan_key,
      to_plan: FREE_PLAN_KEY,
      reason: 'billing period ended',
      before,
      after,
    });
  }

  return due.length;
}
