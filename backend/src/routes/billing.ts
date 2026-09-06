// Workspace billing API. Every figure is derived from real rows:
//   - included-usage numerators come from UsageRecord
//   - the allowance denominators come from INCLUDED_USAGE (plan config)
//   - unbilled charges are summed from rate_micros on the same records
// Nothing is hardcoded per-account; an empty month legitimately reads 0.
//
// Money is integer cents (rates are integer micro-cents) — no float currency.
//
// PLAN CHANGES DO NOT HAPPEN HERE.
// A paid plan is granted by lib/billingState.ts and only in response to a
// signature-verified provider webhook (or an audited admin override). This file
// creates *checkout sessions* and reports state; it never writes `plan_key` to a
// paid value. Spec §7/§57: "Add card → payment method saved only. Add card MUST NOT
// change plan."

import express, { Response } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import prisma from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { looksLikeCardNumber } from '../lib/pan.js';
import { moveCredit } from '../lib/credits.js';
import {
  BILLING_STATE_SELECT,
  FREE_PLAN_KEY,
  cancelSubscription,
  effectivePlanKey,
  isLiveSubscription,
  activateFromPayment,
} from '../lib/billingState.js';
import { catalogPlan, planCatalog, priceFor } from '../lib/planCatalog.js';
import { createCheckout, getBillingConfig } from '../lib/paymentProvider.js';
import { getPlatformDomainConfig } from '../lib/platformDomain.js';
import { formatMoney } from '../lib/invoices.js';
import {
  INCLUDED_USAGE,
  currentPeriod,
  effectiveTier,
  normalizeTier,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
  tierLabel,
  assertWorkspaceWrite,
  type PlanTier,
} from '../lib/workspace.js';

const router = express.Router();

/** Root of the invoice PDF store; `pdf_path` may never escape it. */
const INVOICE_DIR = config.invoicePath;

/** How long a checkout session stays open before it is treated as abandoned. */
const CHECKOUT_TTL_MS = 60 * 60 * 1000;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Sum of rate_micros × quantity, rounded to whole cents. */
function chargeCents(rows: Array<{ quantity: number; rate_micros: number | null }>): number {
  const micros = rows.reduce((sum, r) => sum + (r.rate_micros ?? 0) * r.quantity, 0);
  return Math.round(micros / 10_000);
}

/** Usage total for a metric (optionally one bucket) in the given period. */
function totalFor(
  rows: Array<{ metric: string; bucket: string | null; quantity: number }>,
  metric: string,
  bucket?: string,
): number {
  return rows
    .filter((r) => r.metric === metric && (bucket === undefined || r.bucket === bucket))
    .reduce((sum, r) => sum + r.quantity, 0);
}

/** Percent of an allowance used. NULL allowance (unlimited) => null. */
function percentOf(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(100, (used / limit) * 100);
}

/** §6 card shape: brand, last four, expiry. Never a PAN, never a CVV. */
function cardView(m: {
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
  created_at: Date;
}) {
  return {
    id: m.id,
    provider: m.provider,
    brand: m.brand,
    last4: m.last4,
    exp_month: m.exp_month,
    exp_year: m.exp_year,
    is_default: m.is_default,
    status: m.status,
    type: m.type,
    funding: m.funding,
    billing_name: m.billing_name,
    billing_country: m.billing_country,
    created_at: m.created_at,
    /** Ready-to-render label, so no client has to reinvent the masking. */
    label: `${m.brand} •••• ${m.last4}`,
    expiry_label: `${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)}`,
  };
}

/**
 * The §37 billing state: plan, subscription status and payment status as separate
 * fields. `effective_plan` is what the account is actually entitled to right now —
 * a lapsed Pro reads `plan_key: "pro"`, `effective_plan: "hobby"`, which is exactly
 * the distinction §37 asks for.
 */
function subscriptionView(ws: {
  plan_key: string;
  subscription_status: string;
  payment_status: string;
  billing_provider: string | null;
  subscription_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: Date | null;
}) {
  const effective = effectivePlanKey(ws);
  return {
    plan_key: ws.plan_key,
    plan_label: tierLabel(normalizeTier(ws.plan_key)),
    effective_plan: effective,
    effective_plan_label: tierLabel(normalizeTier(effective)),
    subscription_status: ws.subscription_status,
    payment_status: ws.payment_status,
    billing_provider: ws.billing_provider,
    subscription_id: ws.subscription_id,
    current_period_start: ws.current_period_start,
    current_period_end: ws.current_period_end,
    cancel_at_period_end: ws.cancel_at_period_end,
    live: isLiveSubscription(ws.subscription_status) && effective !== FREE_PLAN_KEY,
    manual_override: ws.manual_override,
    manual_override_reason: ws.manual_override_reason,
    manual_override_at: ws.manual_override_at,
  };
}

// GET /api/billing — the whole billing page in one round trip.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    // The *effective* tier, so a lapsed subscription stops showing Pro allowances.
    const tier = effectiveTier(workspace);
    const period = currentPeriod();
    const included = INCLUDED_USAGE[tier];

    const [records, methods, profile, credit, invoices, domainCount, serviceCount, plans, cfg, openCheckout] =
      await Promise.all([
        prisma.usageRecord.findMany({ where: { workspace_id: workspace.id, period } }),
        prisma.paymentMethod.findMany({
          where: { workspace_id: workspace.id },
          orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
        }),
        prisma.billingProfile.findUnique({ where: { workspace_id: workspace.id } }),
        prisma.creditBalance.findUnique({ where: { workspace_id: workspace.id } }),
        prisma.invoice.findMany({
          where: { workspace_id: workspace.id },
          orderBy: { issued_at: 'desc' },
        }),
        // Live counts, not metered rows: these are "current state" meters.
        prisma.project.count({
          where: { user_id: workspace.owner_id, domain: { not: null } },
        }),
        prisma.project.count({
          where: { user_id: workspace.owner_id, project_type: { not: 'database' } },
        }),
        planCatalog(),
        getBillingConfig(),
        prisma.checkoutSession.findFirst({
          where: { workspace_id: workspace.id, status: 'open', expires_at: { gt: new Date() } },
          orderBy: { created_at: 'desc' },
        }),
      ]);

    const instanceHours = totalFor(records, 'instance_hours');
    const bandwidthBytes = totalFor(records, 'bandwidth_bytes');
    const pipelineMinutes = totalFor(records, 'pipeline_minutes');
    const bandwidthGb = bandwidthBytes / 1024 ** 3;

    const chargeRows = records.filter((r) => (r.rate_micros ?? 0) > 0);
    const grouped = new Map<
      string,
      { resource: string; resource_type: string; unit: string; quantity: number; cents: number }
    >();
    for (const row of chargeRows) {
      const key = `${row.resource_id ?? row.metric}|${row.metric}`;
      const entry = grouped.get(key) ?? {
        resource: row.resource_name ?? row.metric,
        resource_type: row.resource_type ?? row.metric,
        unit: row.unit,
        quantity: 0,
        cents: 0,
      };
      entry.quantity += row.quantity;
      entry.cents += Math.round(((row.rate_micros ?? 0) * row.quantity) / 10_000);
      grouped.set(key, entry);
    }

    const totalCents = chargeCents(chargeRows);
    // Straight-line projection from elapsed days; explicitly labelled as a
    // projection in the UI so it is never mistaken for a billed amount.
    const now = new Date();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
    const elapsed = Math.max(1, now.getUTCDate());
    const projectedCents = Math.round((totalCents / elapsed) * daysInMonth);

    res.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        plan: { key: tier, label: tierLabel(tier) },
      },
      period,
      plans,
      subscription: subscriptionView(workspace),
      checkout: {
        provider: cfg.provider,
        currency: cfg.currency,
        // Publishable ids only — the secret key never leaves the server.
        stripe_publishable_key: cfg.provider === 'stripe' ? cfg.stripe.publishableKey : null,
        razorpay_key_id: cfg.provider === 'razorpay' ? cfg.razorpay.keyId : null,
        manual_instructions: cfg.provider === 'manual' ? cfg.manualInstructions : null,
        pending_session: openCheckout
          ? {
              id: openCheckout.id,
              plan_key: openCheckout.plan_key,
              amount_cents: openCheckout.amount_cents,
              currency: openCheckout.currency,
              redirect_url: openCheckout.redirect_url,
              provider_ref: openCheckout.provider_ref,
              expires_at: openCheckout.expires_at,
            }
          : null,
      },
      payment_methods: methods.map(cardView),
      billing_profile: profile
        ? {
            company: profile.company,
            address1: profile.address1,
            address2: profile.address2,
            city: profile.city,
            state: profile.state,
            postal_code: profile.postal_code,
            country: profile.country,
            vat_id: profile.vat_id,
          }
        : null,
      included_usage: {
        instance_hours: {
          used: instanceHours,
          limit: included.instance_hours,
          percent: percentOf(instanceHours, included.instance_hours),
          unit: 'hours',
        },
        custom_domains: {
          used: domainCount,
          limit: included.custom_domains,
          percent: percentOf(domainCount, included.custom_domains),
          unit: 'domains',
        },
        services: {
          used: serviceCount,
          limit: included.services,
          percent: percentOf(serviceCount, included.services),
          unit: 'services',
        },
        bandwidth: {
          used: bandwidthGb,
          limit: included.bandwidth_gb,
          percent: percentOf(bandwidthGb, included.bandwidth_gb),
          unit: 'GB',
          breakdown: {
            http_response: totalFor(records, 'bandwidth_bytes', 'http_response') / 1024 ** 3,
            service_initiated:
              totalFor(records, 'bandwidth_bytes', 'service_initiated') / 1024 ** 3,
            websocket: totalFor(records, 'bandwidth_bytes', 'websocket') / 1024 ** 3,
            private_link: totalFor(records, 'bandwidth_bytes', 'private_link') / 1024 ** 3,
          },
        },
        pipeline_minutes: {
          used: pipelineMinutes,
          limit: included.pipeline_minutes,
          percent: percentOf(pipelineMinutes, included.pipeline_minutes),
          unit: 'minutes',
        },
      },
      unbilled: {
        total_cents: totalCents,
        projected_cents: projectedCents,
        groups: [...grouped.values()],
      },
      credit: { balance_cents: credit?.balance_cents ?? 0 },
      invoices: invoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        period_start: inv.period_start,
        period_end: inv.period_end,
        amount_cents: inv.amount_cents,
        currency: inv.currency,
        status: inv.status,
        has_pdf: !!inv.pdf_path,
        issued_at: inv.issued_at,
        paid_at: inv.paid_at,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] load failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load billing.');
  }
});

// GET /api/billing/usage.csv — Download as CSV (Date, Resource, ... , Amount).
router.get('/usage.csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const period =
      typeof req.query.period === 'string' && /^\d{4}-\d{2}$/.test(req.query.period)
        ? req.query.period
        : currentPeriod();

    const rows = await prisma.usageRecord.findMany({
      where: { workspace_id: workspace.id, period },
      orderBy: { recorded_at: 'asc' },
    });

    const escape = (value: string | number): string => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = ['Date,Resource,Resource Type,Usage,Unit,Rate,Amount'];
    for (const row of rows) {
      const amount = ((row.rate_micros ?? 0) * row.quantity) / 1_000_000;
      lines.push(
        [
          row.recorded_at.toISOString(),
          escape(row.resource_name ?? row.metric),
          escape(row.resource_type ?? row.metric),
          row.quantity,
          escape(row.unit),
          ((row.rate_micros ?? 0) / 1_000_000).toFixed(6),
          amount.toFixed(4),
        ].join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="workspace-billing-${period}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] csv failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not export usage.');
  }
});

// GET /api/billing/subscription — the §37 billing state on its own.
router.get('/subscription', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const [events, payments] = await Promise.all([
      prisma.subscriptionEvent.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
      prisma.payment.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    ]);

    res.json({
      subscription: subscriptionView(workspace),
      history: events.map((e) => ({
        id: e.id,
        event: e.event,
        source: e.source,
        from_plan: e.from_plan,
        to_plan: e.to_plan,
        reason: e.reason,
        created_at: e.created_at,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        provider: p.provider,
        status: p.status,
        amount_cents: p.amount_cents,
        currency: p.currency,
        amount_label: formatMoney(p.amount_cents, p.currency),
        plan_key: p.plan_key,
        description: p.description,
        failure_message: p.failure_message,
        refunded_cents: p.refunded_cents,
        created_at: p.created_at,
        succeeded_at: p.succeeded_at,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] subscription load failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load the subscription.');
  }
});

/**
 * PATCH /api/billing/plan — the only plan change a customer can make directly:
 * cancelling down to the free tier.
 *
 * This endpoint used to flip `plan_key` to any paid tier as soon as a card existed
 * (spec §7/§57: "USER ADDS CARD → PLAN CHANGES IMMEDIATELY → NO PAYMENT IS ACTUALLY
 * CHARGED"). It cannot any more: an upgrade is refused with `CHECKOUT_REQUIRED` and
 * has to go through POST /checkout → provider → verified webhook.
 */
router.patch('/plan', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const key = String(req.body?.plan_key || '').toLowerCase();
    const plan = await catalogPlan(key);
    if (!plan) return fail(res, 400, 'INVALID_PLAN', 'Unknown plan.');

    if (plan.price_cents > 0 || plan.key !== FREE_PLAN_KEY) {
      // Deliberately not "insert a card and you're on Pro". The client is told where
      // the real flow lives instead of being handed the plan.
      return res.status(409).json({
        success: false,
        error: {
          code: 'CHECKOUT_REQUIRED',
          message: `${plan.name} has to be paid for. Start a checkout to upgrade.`,
        },
        checkout_endpoint: '/api/billing/checkout',
        plan: { key: plan.key, name: plan.name, price_cents: plan.price_cents },
      });
    }

    const effective = effectivePlanKey(workspace);
    if (effective === FREE_PLAN_KEY && !isLiveSubscription(workspace.subscription_status)) {
      return fail(res, 409, 'SAME_PLAN', 'You are already on the free plan.');
    }
    if (workspace.cancel_at_period_end) {
      return fail(res, 409, 'ALREADY_CANCELING', 'This subscription is already set to cancel.');
    }

    // Keeps them on what they paid for until the period runs out — see
    // cancelSubscription(). A paid-for month is not forfeited by downgrading.
    const result = await cancelSubscription({
      workspace_id: workspace.id,
      at_period_end: true,
      reason: typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 400) : null,
      source: 'user',
    });
    if (!result.ok) return fail(res, 409, 'CANCEL_FAILED', result.detail ?? 'Could not cancel.');

    await writeAudit(req, 'billing.plan.cancel', {
      target_type: 'workspace',
      target_id: workspace.id,
      target_label: workspace.name,
      before: { plan_key: workspace.plan_key, subscription_status: workspace.subscription_status },
      after: { cancel_at_period_end: true },
      reason: 'customer downgrade to free',
    });

    const fresh = await prisma.workspace.findUnique({
      where: { id: workspace.id },
      select: BILLING_STATE_SELECT,
    });
    res.json({
      success: true,
      subscription: fresh ? subscriptionView(fresh) : null,
      message: workspace.current_period_end
        ? 'Your plan will end when the current period does.'
        : 'Your plan has been cancelled.',
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] plan change failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not change the plan.');
  }
});

/**
 * Absolute origin the provider should send the browser back to.
 *
 * Configuration first, request headers last: a forged `Host` header must not decide
 * where a paying customer lands after checkout.
 */
async function appOrigin(req: AuthenticatedRequest): Promise<string> {
  const envUrl = process.env.PUBLIC_APP_URL?.trim();
  if (envUrl && /^https?:\/\//.test(envUrl)) return envUrl.replace(/\/+$/, '');

  const domain = await getPlatformDomainConfig();
  if (domain.baseDomain) return `https://${domain.baseDomain}`;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, '');
  const host = req.headers.host;
  if (host) return `${req.protocol || 'http'}://${host}`;
  return 'http://localhost:5173';
}

/** Shape a checkout session for the client. No secrets, no provider credentials. */
function checkoutView(
  session: {
    id: string;
    plan_key: string;
    amount_cents: number;
    currency: string;
    provider: string;
    provider_ref: string | null;
    redirect_url: string | null;
    status: string;
    payment_id: string | null;
    expires_at: Date;
    created_at: Date;
    completed_at: Date | null;
  },
  extra: { instructions?: string | null; publishable_key?: string | null } = {},
) {
  return {
    id: session.id,
    plan_key: session.plan_key,
    amount_cents: session.amount_cents,
    amount_label: formatMoney(session.amount_cents, session.currency),
    currency: session.currency,
    provider: session.provider,
    provider_ref: session.provider_ref,
    redirect_url: session.redirect_url,
    status: session.status,
    payment_id: session.payment_id,
    expires_at: session.expires_at,
    created_at: session.created_at,
    completed_at: session.completed_at,
    instructions: extra.instructions ?? null,
    publishable_key: extra.publishable_key ?? null,
  };
}

/**
 * POST /api/billing/checkout — start paying for a plan.
 *
 * This is the *only* customer-facing route to a paid tier, and it does not grant
 * anything: it records what is being bought (plan, amount, currency — server-side,
 * never from the client) and hands back where to pay. The plan moves later, when a
 * signature-verified webhook reaches `activateFromPayment()` (§7, §34).
 */
router.post('/checkout', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const key = String(req.body?.plan_key || '').toLowerCase();
    const interval: 'month' | 'year' = req.body?.interval === 'year' ? 'year' : 'month';

    const plan = await catalogPlan(key);
    if (!plan || plan.archived) return fail(res, 400, 'INVALID_PLAN', 'Unknown plan.');
    if (plan.key === FREE_PLAN_KEY) {
      return fail(res, 400, 'FREE_PLAN', 'The free plan has nothing to pay for.');
    }

    // The amount is computed here from the plan row. A client-supplied price is
    // never read — that is the whole point of §34.
    const amount = priceFor(plan, interval);
    if (amount <= 0) {
      return fail(
        res,
        409,
        'PLAN_NOT_PURCHASABLE',
        `${plan.name} has no price configured. Ask an operator to set one.`,
      );
    }

    const effective = effectivePlanKey(workspace);
    if (effective === plan.key && !workspace.cancel_at_period_end) {
      return fail(res, 409, 'SAME_PLAN', `You are already on ${plan.name}.`);
    }

    const cfg = await getBillingConfig();
    const currency = cfg.currency;

    // Reuse a live session for the same purchase rather than stacking pending
    // payments the customer would then see twice.
    const existing = await prisma.checkoutSession.findFirst({
      where: {
        workspace_id: workspace.id,
        status: 'open',
        plan_key: plan.key,
        amount_cents: amount,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });
    if (existing) {
      return res.json({
        success: true,
        reused: true,
        checkout: checkoutView(existing, {
          instructions: cfg.provider === 'manual' ? cfg.manualInstructions : null,
          publishable_key:
            cfg.provider === 'stripe' ? cfg.stripe.publishableKey : cfg.razorpay.keyId,
        }),
      });
    }

    // ── Wallet-funded activation ──────────────────────────────────────────
    // Credit is money the workspace already holds (a promo an admin granted, a
    // refund). Spending it is a real, ledgered payment — not a frontend claim — so
    // it may activate directly. Partial credit is deliberately NOT applied: a
    // half-funded charge that then fails would have burnt the credit.
    const balance = await prisma.creditBalance.findUnique({
      where: { workspace_id: workspace.id },
    });
    if ((balance?.balance_cents ?? 0) >= amount) {
      const payment = await prisma.payment.create({
        data: {
          workspace_id: workspace.id,
          user_id: req.user?.userId ?? null,
          provider: 'credit',
          status: 'pending',
          amount_cents: amount,
          currency,
          plan_key: plan.key,
          kind: 'subscription',
          description: `${plan.name} plan (${interval}) — paid from workspace credit`,
        },
      });

      const debit = await moveCredit({
        workspace_id: workspace.id,
        amount_cents: -amount,
        kind: 'usage',
        reason: `${plan.name} plan (${interval}) — payment ${payment.id}`,
      });
      if (!debit.ok) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'failed', failure_code: 'credit_debit_failed', failed_at: new Date() },
        });
        return fail(res, 409, 'CREDIT_FAILED', debit.detail ?? 'Could not spend your credit.');
      }

      const result = await activateFromPayment({
        payment_id: payment.id,
        source: 'system',
        observed_amount_cents: amount,
        observed_currency: currency,
        reason: 'paid from workspace credit',
      });
      if (!result.ok) {
        // Compensating entry: the customer gets their credit back and both movements
        // stay visible in the ledger.
        await moveCredit({
          workspace_id: workspace.id,
          amount_cents: amount,
          kind: 'refund',
          reason: `activation failed for payment ${payment.id}: ${result.detail ?? 'unknown error'}`,
        });
        return fail(res, 500, 'ACTIVATION_FAILED', result.detail ?? 'Could not activate the plan.');
      }

      await writeAudit(req, 'billing.checkout.credit', {
        target_type: 'workspace',
        target_id: workspace.id,
        target_label: workspace.name,
        severity: 'warning',
        metadata: { plan_key: plan.key, amount_cents: amount, payment_id: payment.id },
        after: { plan_key: plan.key, funded_by: 'credit' },
      });

      const fresh = await prisma.workspace.findUnique({
        where: { id: workspace.id },
        select: BILLING_STATE_SELECT,
      });
      return res.status(201).json({
        success: true,
        activated: true,
        funded_by: 'credit',
        credit_applied_cents: amount,
        invoice_id: result.invoice_id ?? null,
        subscription: fresh ? subscriptionView(fresh) : null,
        message: `${plan.name} is active. ${formatMoney(amount, currency)} was taken from your credit balance.`,
      });
    }

    // ── Provider-funded checkout ──────────────────────────────────────────
    const payment = await prisma.payment.create({
      data: {
        workspace_id: workspace.id,
        user_id: req.user?.userId ?? null,
        provider: cfg.provider,
        status: 'pending',
        amount_cents: amount,
        currency,
        plan_key: plan.key,
        kind: 'subscription',
        description: `${plan.name} plan (${interval === 'year' ? 'annual' : 'monthly'})`,
      },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        workspace_id: workspace.id,
        user_id: req.user?.userId ?? null,
        plan_key: plan.key,
        amount_cents: amount,
        currency,
        provider: cfg.provider,
        status: 'open',
        payment_id: payment.id,
        expires_at: new Date(Date.now() + CHECKOUT_TTL_MS),
      },
    });

    const origin = await appOrigin(req);
    let intent;
    try {
      intent = await createCheckout({
        provider: cfg.provider,
        cfg,
        sessionId: session.id,
        planKey: plan.key,
        planName: `${plan.name} plan`,
        amountCents: amount,
        currency,
        customerEmail: workspace.email ?? req.user?.email ?? null,
        successUrl: `${origin}/billing?checkout=${session.id}&status=success`,
        cancelUrl: `${origin}/billing?checkout=${session.id}&status=cancelled`,
      });
    } catch (providerErr) {
      // The provider refused or is unreachable. Nothing was charged and nothing was
      // granted; the attempt is recorded so support can see it.
      const message = providerErr instanceof Error ? providerErr.message : 'Payment provider error.';
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'canceled' },
      });
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failure_code: 'provider_unavailable',
          failure_message: message.slice(0, 400),
          failed_at: new Date(),
        },
      });
      console.error('[billing] checkout creation failed:', providerErr);
      return fail(res, 502, 'PROVIDER_ERROR', message);
    }

    const updated = await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { provider_ref: intent.providerRef, redirect_url: intent.redirectUrl },
    });
    if (intent.paymentRef) {
      // Lets the webhook match on the provider's own id. Unique column, so a clash
      // (two sessions, same intent) is ignored rather than fatal.
      await prisma.payment
        .update({ where: { id: payment.id }, data: { provider_ref: intent.paymentRef } })
        .catch(() => {});
    }

    await writeAudit(req, 'billing.checkout.start', {
      target_type: 'workspace',
      target_id: workspace.id,
      target_label: workspace.name,
      metadata: {
        plan_key: plan.key,
        interval,
        amount_cents: amount,
        currency,
        provider: cfg.provider,
        checkout_session_id: session.id,
      },
    });

    res.status(201).json({
      success: true,
      activated: false,
      checkout: checkoutView(updated, {
        instructions: cfg.provider === 'manual' ? intent.instructions : null,
        publishable_key: cfg.provider === 'stripe' ? cfg.stripe.publishableKey : cfg.razorpay.keyId,
      }),
      message:
        cfg.provider === 'manual'
          ? 'Follow the payment instructions. Your plan activates once the payment is confirmed.'
          : 'Complete the payment to activate your plan.',
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] checkout failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not start checkout.');
  }
});

/**
 * GET /api/billing/checkout/:id — poll a session.
 *
 * The status shown here comes from the Payment row, i.e. from what the webhook did.
 * A client that "returns successfully" from the provider still sees `pending` until
 * the signed event lands, which is the §34 behaviour rather than a bug.
 */
router.get('/checkout/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = await prisma.checkoutSession.findUnique({ where: { id: req.params.id } });
    if (!session) return fail(res, 404, 'NOT_FOUND', 'Checkout session not found.');
    // Authorizes the session's workspace; outsiders get 404 from resolveWorkspace.
    const workspace = await resolveWorkspace(req, session.workspace_id);

    let current = session;
    if (current.status === 'open' && current.expires_at.getTime() < Date.now()) {
      current = await prisma.checkoutSession.update({
        where: { id: current.id },
        data: { status: 'expired' },
      });
    }

    const payment = current.payment_id
      ? await prisma.payment.findUnique({ where: { id: current.payment_id } })
      : null;

    res.json({
      checkout: checkoutView(current),
      payment: payment
        ? {
            id: payment.id,
            status: payment.status,
            amount_cents: payment.amount_cents,
            currency: payment.currency,
            failure_code: payment.failure_code,
            failure_message: payment.failure_message,
            succeeded_at: payment.succeeded_at,
          }
        : null,
      subscription: subscriptionView(workspace),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] checkout read failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not read the checkout session.');
  }
});

// POST /api/billing/checkout/:id/cancel — abandon an unpaid session.
router.post('/checkout/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = await prisma.checkoutSession.findUnique({ where: { id: req.params.id } });
    if (!session) return fail(res, 404, 'NOT_FOUND', 'Checkout session not found.');
    const workspace = await resolveWorkspace(req, session.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    if (session.status !== 'open') {
      return fail(res, 409, 'NOT_OPEN', `This checkout is already ${session.status}.`);
    }

    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status: 'canceled' },
    });
    if (session.payment_id) {
      // Only a payment that never succeeded is cancelled — a webhook that landed
      // first wins, so cancelling cannot revoke something already paid for.
      await prisma.payment.updateMany({
        where: { id: session.payment_id, status: { in: ['pending', 'processing'] } },
        data: { status: 'canceled' },
      });
    }
    await writeAudit(req, 'billing.checkout.cancel', {
      target_type: 'workspace',
      target_id: workspace.id,
      metadata: { checkout_session_id: session.id, plan_key: session.plan_key },
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] checkout cancel failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not cancel the checkout.');
  }
});

// POST /api/billing/payment-methods — store provider metadata only, never a PAN.
//
// §57: adding a card saves a payment method. It does not change the plan, and there
// is no code path from here to `plan_key`.
router.post('/payment-methods', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const token = typeof req.body?.provider_ref === 'string' ? req.body.provider_ref.trim() : '';
    const brand = typeof req.body?.brand === 'string' ? req.body.brand.trim() : '';
    const last4 = typeof req.body?.last4 === 'string' ? req.body.last4.trim() : '';
    const expMonth = Number(req.body?.exp_month);
    const expYear = Number(req.body?.exp_year);

    if (!token) return fail(res, 400, 'NO_TOKEN', 'A payment provider token is required.');
    if (!/^\d{4}$/.test(last4)) return fail(res, 400, 'INVALID_LAST4', 'Last 4 digits are invalid.');
    if (!brand) return fail(res, 400, 'INVALID_BRAND', 'Card brand is required.');
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
      return fail(res, 400, 'INVALID_EXPIRY', 'Expiry month must be 1–12.');
    }
    const thisYear = new Date().getUTCFullYear();
    if (!Number.isInteger(expYear) || expYear < thisYear || expYear > thisYear + 25) {
      return fail(res, 400, 'INVALID_EXPIRY', 'Expiry year is out of range.');
    }
    // Defence in depth: refuse anything that is actually a card number. Tested by
    // PAN shape + Luhn rather than "has 12 digits", so all-numeric provider tokens
    // still work — see lib/pan.ts for the trade-off.
    if (looksLikeCardNumber(JSON.stringify(req.body))) {
      return fail(
        res,
        400,
        'RAW_CARD',
        'That looks like a real card number. Paste the reference your payment ' +
          'provider returned (e.g. pm_… or tok_…) — Docklift stores only the brand, ' +
          'last four digits and expiry, never a card number.',
      );
    }

    const existing = await prisma.paymentMethod.count({ where: { workspace_id: workspace.id } });
    // §6 display metadata. Constrained to the documented vocabularies so the column
    // cannot become a free-text field the admin UI has to guess at.
    const oneOf = (value: unknown, allowed: string[], fallback: string): string => {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return allowed.includes(v) ? v : fallback;
    };
    const optional = (value: unknown, max: number): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim().slice(0, max);
      return trimmed || null;
    };
    const method = await prisma.paymentMethod.create({
      data: {
        workspace_id: workspace.id,
        provider: typeof req.body?.provider === 'string' ? req.body.provider : 'manual',
        provider_ref: token,
        brand,
        last4,
        exp_month: expMonth,
        exp_year: expYear,
        is_default: existing === 0,
        billing_name: optional(req.body?.billing_name, 120),
        billing_country: optional(req.body?.billing_country, 2)?.toUpperCase() ?? null,
        type: oneOf(req.body?.type, ['card', 'upi', 'paypal', 'bank_account'], 'card'),
        funding: oneOf(req.body?.funding, ['credit', 'debit', 'prepaid', 'unknown'], 'unknown'),
      },
    });
    await writeAudit(req, 'billing.card.add', `payment_method:${method.id}`, {
      brand,
      last4,
    });
    res.status(201).json({
      success: true,
      // Same masked shape as GET, so a client never has two card renderings.
      payment_method: cardView(method),
      // Stated explicitly because this is the §57 bug: the response says what did
      // *not* happen, so no client can infer an upgrade from a 201 here.
      plan_changed: false,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] add card failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the card.');
  }
});

// POST /api/billing/payment-methods/:id/default — set as default.
router.post('/payment-methods/:id/default', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const method = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
    if (!method) return fail(res, 404, 'NOT_FOUND', 'Card not found.');
    const workspace = await resolveWorkspace(req, method.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    await prisma.$transaction([
      prisma.paymentMethod.updateMany({
        where: { workspace_id: workspace.id },
        data: { is_default: false },
      }),
      prisma.paymentMethod.update({ where: { id: method.id }, data: { is_default: true } }),
    ]);
    await writeAudit(req, 'billing.card.default', `payment_method:${method.id}`);
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] default card failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the card.');
  }
});

// DELETE /api/billing/payment-methods/:id — blocked while a paid plan needs it.
router.delete('/payment-methods/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const method = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
    if (!method) return fail(res, 404, 'NOT_FOUND', 'Card not found.');
    const workspace = await resolveWorkspace(req, method.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    const remaining = await prisma.paymentMethod.count({
      where: { workspace_id: workspace.id, id: { not: method.id } },
    });
    // The *effective* tier: a workspace whose paid period has already lapsed is on
    // the free plan in practice, so it should not be told to downgrade first.
    if (remaining === 0 && effectiveTier(workspace) !== 'hobby') {
      return fail(
        res,
        409,
        'PLAN_REQUIRES_CARD',
        'Downgrade to Hobby before removing your last payment method.',
      );
    }

    await prisma.paymentMethod.delete({ where: { id: method.id } });
    if (method.is_default && remaining > 0) {
      const next = await prisma.paymentMethod.findFirst({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'asc' },
      });
      if (next) {
        await prisma.paymentMethod.update({ where: { id: next.id }, data: { is_default: true } });
      }
    }
    await writeAudit(req, 'billing.card.remove', `payment_method:${method.id}`);
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] remove card failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not remove the card.');
  }
});

// PUT /api/billing/profile — billing information (company / address / VAT).
router.put('/profile', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const field = (key: string, max = 120): string | null => {
      const raw = req.body?.[key];
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      return trimmed ? trimmed.slice(0, max) : null;
    };

    const country = field('country', 2 + 60);
    if (req.body?.country && !country) {
      return fail(res, 400, 'INVALID_COUNTRY', 'Country is required.');
    }

    const data = {
      company: field('company'),
      address1: field('address1'),
      address2: field('address2'),
      city: field('city'),
      state: field('state'),
      postal_code: field('postal_code', 20),
      country,
      vat_id: field('vat_id', 40),
    };

    const saved = await prisma.billingProfile.upsert({
      where: { workspace_id: workspace.id },
      update: data,
      create: { workspace_id: workspace.id, ...data },
    });
    await writeAudit(req, 'billing.profile.update', `workspace:${workspace.id}`);
    res.json({
      success: true,
      billing_profile: {
        company: saved.company,
        address1: saved.address1,
        address2: saved.address2,
        city: saved.city,
        state: saved.state,
        postal_code: saved.postal_code,
        country: saved.country,
        vat_id: saved.vat_id,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] profile failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save billing information.');
  }
});

// GET /api/billing/invoices/:id/pdf — stream a stored invoice PDF.
//
// `pdf_path` is written by the invoicing job, never by a request, but the path is
// still confined to INVOICE_DIR before it is opened so a bad row cannot be turned
// into an arbitrary-file read.
router.get('/invoices/:id/pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    // Authorizes the invoice's own workspace; outsiders get 404 from here.
    await resolveWorkspace(req, invoice.workspace_id);
    if (!invoice.pdf_path) return fail(res, 404, 'NO_PDF', 'No PDF is available for this invoice.');

    const resolved = path.resolve(INVOICE_DIR, invoice.pdf_path);
    if (resolved !== INVOICE_DIR && !resolved.startsWith(INVOICE_DIR + path.sep)) {
      console.error('[billing] invoice pdf outside store:', invoice.id);
      return fail(res, 404, 'NO_PDF', 'No PDF is available for this invoice.');
    }

    const stats = await fsp.stat(resolved).catch(() => null);
    if (!stats?.isFile()) return fail(res, 404, 'NO_PDF', 'No PDF is available for this invoice.');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.id}.pdf"`);
    res.setHeader('Content-Length', stats.size);
    const stream = fs.createReadStream(resolved);
    stream.on('error', (streamErr) => {
      console.error('[billing] invoice pdf stream failed:', streamErr);
      if (!res.headersSent) fail(res, 500, 'INTERNAL', 'Could not read the invoice.');
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] invoice pdf failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not download the invoice.');
  }
});

/**
 * POST /api/billing/promo — redeem a coupon.
 *
 * A `fixed` code puts money in the wallet, through `moveCredit()` so the movement is
 * ledgered like every other one (§13: "Never silently modify balances"). A `percent`
 * code is not wallet money — it discounts a purchase — so it is validated and
 * reported back for checkout to apply rather than being converted into credit.
 */
router.post('/promo', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!code) return fail(res, 400, 'NO_CODE', 'Enter a promo code.');

    const promo = await prisma.promoCode.findUnique({
      where: { code },
      include: { redemptions: true },
    });
    // Same message for "no such code" and "disabled code" — an attacker should not be
    // able to enumerate which codes exist.
    if (!promo || !promo.active) {
      return fail(res, 404, 'INVALID_CODE', 'That promo code is not valid.');
    }
    if (promo.starts_at && promo.starts_at.getTime() > Date.now()) {
      return fail(res, 409, 'NOT_STARTED', 'That promo code is not active yet.');
    }
    if (promo.expires_at && promo.expires_at.getTime() < Date.now()) {
      return fail(res, 409, 'EXPIRED', 'That promo code has expired.');
    }
    if (promo.redemptions.some((r) => r.workspace_id === workspace.id)) {
      return fail(res, 409, 'ALREADY_REDEEMED', 'This code has already been redeemed.');
    }
    if (promo.max_redemables !== null && promo.redemptions.length >= promo.max_redemables) {
      return fail(res, 409, 'FULLY_REDEEMED', 'That promo code is no longer available.');
    }

    const planKeys = Array.isArray(promo.plan_keys)
      ? (promo.plan_keys as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];

    if (promo.kind === 'percent') {
      const percent = promo.percent_off ?? 0;
      if (percent <= 0) {
        return fail(res, 409, 'INVALID_CODE', 'That promo code is not configured correctly.');
      }
      // Not redeemed here: a discount is consumed by a purchase, and marking it used
      // now would burn it if the customer never checks out.
      return res.json({
        success: true,
        kind: 'percent',
        percent_off: percent,
        plan_keys: planKeys,
        added_cents: 0,
        message: `${percent}% off will be applied at checkout.`,
      });
    }

    if (promo.amount_cents <= 0) {
      return fail(res, 409, 'INVALID_CODE', 'That promo code is not configured correctly.');
    }

    // Redemption first: the unique index on (promo_code_id, workspace_id) is what
    // actually stops a double redeem from two concurrent requests, and it must fail
    // *before* the credit moves rather than after.
    try {
      await prisma.promoRedemption.create({
        data: { promo_code_id: promo.id, workspace_id: workspace.id },
      });
    } catch {
      return fail(res, 409, 'ALREADY_REDEEMED', 'This code has already been redeemed.');
    }

    const moved = await moveCredit({
      workspace_id: workspace.id,
      amount_cents: promo.amount_cents,
      kind: 'promo',
      reason: `promo code ${promo.code} redeemed`,
    });
    if (!moved.ok) {
      await prisma.promoRedemption
        .deleteMany({ where: { promo_code_id: promo.id, workspace_id: workspace.id } })
        .catch(() => {});
      return fail(res, 500, 'CREDIT_FAILED', moved.detail ?? 'Could not apply the credit.');
    }

    await writeAudit(req, 'billing.promo.redeem', {
      target_type: 'workspace',
      target_id: workspace.id,
      target_label: workspace.name,
      metadata: { code: promo.code, amount_cents: promo.amount_cents },
      after: { balance_cents: moved.balance_cents },
    });
    res.json({
      success: true,
      kind: 'fixed',
      added_cents: promo.amount_cents,
      balance_cents: moved.balance_cents ?? 0,
      message: `${formatMoney(promo.amount_cents, (await getBillingConfig()).currency)} added to your credit balance.`,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] promo failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not redeem the code.');
  }
});

export default router;
