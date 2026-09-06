// Admin billing API — the cross-tenant money surface (spec §8–§13, §42, §44, §58, §59).
//
// Mounted at /api/admin alongside routes/admin.ts, behind the same
// authMiddleware + requireAdminAccess + adminPermissionGate chain, so every path
// here resolves to a real permission: /subscriptions → billing.view/manage,
// /payments → payments.view, /refunds → refunds.manage, /invoices →
// invoices.manage, /credits → credits.manage, /coupons → coupons.manage.
// It is a separate file only because admin.ts is already 1700 lines; it is not a
// separate trust boundary.
//
// Three rules this file exists to keep:
//
//   1. It cannot create money. There is no endpoint here that marks a payment
//      succeeded — only a signature-verified webhook does that (§34). An admin
//      granting a plan goes through manualOverride(), which sets
//      payment_status = 'none' and refuses to fabricate a Payment row (§59).
//   2. Nothing sensitive leaves. Card fields are selected explicitly (brand,
//      last4, expiry, funding); there is no PAN or CVV column to leak (§6).
//   3. Every mutation carries an operator, a reason and a before/after snapshot
//      into the audit log (§10, §24).
import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { type AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermission } from '../lib/adminPermissions.js';
import {
  BILLING_STATE_SELECT,
  cancelSubscription,
  effectivePlanKey,
  isLiveSubscription,
  isPaidPlan,
  manualOverride,
  recordRefund,
  writeSubscriptionEvent,
  type BillingState,
} from '../lib/billingState.js';
import { creditBalance, moveCredit, type CreditKind } from '../lib/credits.js';
import { formatMoney, renderInvoiceText } from '../lib/invoices.js';
import { planCatalog } from '../lib/planCatalog.js';

const router = Router();

// ── shared helpers ───────────────────────────────────────────────────────────

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Server-side paging (§42: "Do not load thousands of records at once"). */
function parsePaging(req: AuthenticatedRequest): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt((req.query.pageSize as string) || '25', 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** RFC-4180 CSV cell. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

function sendCsv(res: Response, filenameBase: string, columns: string[], rows: Array<Record<string, unknown>>) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}-${stamp}.csv"`);
  res.send(toCsv(columns, rows));
}

/** Hard cap on exported rows — a download, not a data dump that OOMs the server. */
const EXPORT_ROW_CAP = 50_000;

/**
 * The operator's stated justification. §10/§24/§59 all require one for financial
 * and override actions, so this returns '' rather than a default: the caller
 * refuses the request, it never invents a reason on the admin's behalf.
 */
function reasonOf(req: AuthenticatedRequest): string {
  const raw = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  return raw.slice(0, 500);
}

/** `?from=&to=` as a Prisma date filter, or undefined when neither is given. */
function dateFilter(req: AuthenticatedRequest): Prisma.DateTimeFilter | undefined {
  const from = (req.query.from as string)?.trim();
  const to = (req.query.to as string)?.trim();
  const filter: Prisma.DateTimeFilter = {};
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) filter.gte = d;
  }
  if (to) {
    const d = new Date(to);
    // An inclusive end date: `to=2026-09-04` must include that whole day.
    if (!isNaN(d.getTime())) filter.lte = /T/.test(to) ? d : new Date(d.getTime() + 86_399_999);
  }
  return Object.keys(filter).length ? filter : undefined;
}

function trimmed(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function centsOf(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Owner + workspace identity, the join every money table needs for display. */
const OWNER_SELECT = {
  id: true,
  name: true,
  email: true,
  owner: { select: { id: true, name: true, email: true, status: true } },
} satisfies Prisma.WorkspaceSelect;

type OwnerShape = {
  id: string;
  name: string;
  owner?: { id: string; name: string | null; email: string; status: string } | null;
  email?: string | null;
};

/**
 * Flattened account identity. Always the same seven keys, with nulls when the
 * relation is missing, so every row type is stable for the table components and
 * the CSV exporters (a conditional spread would make the columns come and go).
 */
function accountOf(ws: OwnerShape | null | undefined) {
  return {
    workspace_id: ws?.id ?? null,
    workspace_name: ws?.name ?? null,
    user_id: ws?.owner?.id ?? null,
    user_name: ws?.owner?.name ?? null,
    user_email: ws?.owner?.email ?? null,
    user_status: ws?.owner?.status ?? null,
    billing_email: ws?.email ?? ws?.owner?.email ?? null,
  };
}

/**
 * Card as the admin panel is allowed to see it (§6, §44, §58). Built from an
 * explicit field list: `label` is rendered server-side so no client can widen the
 * mask, and there is deliberately no branch here that could ever emit more.
 */
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
    label: `${m.brand} •••• ${m.last4}`,
    expiry_label: `${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)}`,
  };
}

const CARD_SELECT = {
  id: true,
  provider: true,
  brand: true,
  last4: true,
  exp_month: true,
  exp_year: true,
  is_default: true,
  status: true,
  type: true,
  funding: true,
  billing_name: true,
  billing_country: true,
  created_at: true,
} satisfies Prisma.PaymentMethodSelect;

/** §37 billing state, flattened for a table row, with the entitlement computed. */
function subscriptionRow(
  ws: OwnerShape & BillingState & { created_at: Date; updated_at: Date | null },
  planNames: Map<string, string>,
) {
  const effective = effectivePlanKey(ws);
  return {
    ...accountOf(ws),
    plan_key: ws.plan_key,
    plan_name: planNames.get(ws.plan_key) ?? ws.plan_key,
    // What the account actually gets right now. Differs from plan_key whenever a
    // paid period has lapsed or a payment failed — that gap is the whole point of
    // reporting both (§37).
    effective_plan: effective,
    effective_plan_name: planNames.get(effective) ?? effective,
    entitlement_matches_plan: effective === ws.plan_key,
    subscription_status: ws.subscription_status,
    payment_status: ws.payment_status,
    billing_provider: ws.billing_provider,
    subscription_id: ws.subscription_id,
    current_period_start: ws.current_period_start,
    current_period_end: ws.current_period_end,
    cancel_at_period_end: ws.cancel_at_period_end,
    live: isLiveSubscription(ws.subscription_status),
    manual_override: ws.manual_override,
    manual_override_by: ws.manual_override_by,
    manual_override_reason: ws.manual_override_reason,
    manual_override_at: ws.manual_override_at,
    created_at: ws.created_at,
    updated_at: ws.updated_at,
  };
}

/** plan key → display name, for every row that shows a plan. */
async function planNameMap(): Promise<Map<string, string>> {
  const plans = await prisma.plan.findMany({ select: { key: true, name: true } });
  return new Map(plans.map((p) => [p.key, p.name]));
}

/** Monthly-equivalent price of a plan, in cents — the unit MRR is measured in. */
async function monthlyPriceMap(): Promise<Map<string, number>> {
  const plans = await prisma.plan.findMany({
    select: { key: true, price_cents: true, interval: true },
  });
  const map = new Map<string, number>();
  for (const p of plans) {
    const monthly = p.interval === 'year' ? Math.round(p.price_cents / 12) : p.price_cents;
    map.set(p.key, monthly);
  }
  return map;
}

// ── §8 subscriptions ─────────────────────────────────────────────────────────

/**
 * Every workspace as a subscription row. The Workspace *is* the subscription in
 * this schema (§37 fields live there); the `Subscription` table is the historical
 * record of periods, so listing workspaces is what gives an accurate "who is on
 * what right now" — including accounts that never paid, which a payments-table
 * join would silently drop.
 */
function subscriptionWhere(req: AuthenticatedRequest): Prisma.WorkspaceWhereInput {
  const where: Prisma.WorkspaceWhereInput = {};
  const status = trimmed(req.query.status);
  const plan = trimmed(req.query.plan);
  const provider = trimmed(req.query.provider);
  const override = trimmed(req.query.manual_override);
  const q = trimmed(req.query.q);

  if (status && status !== 'all') where.subscription_status = status;
  if (plan && plan !== 'all') where.plan_key = plan;
  if (provider && provider !== 'all') where.billing_provider = provider;
  if (override === 'true') where.manual_override = true;
  if (override === 'false') where.manual_override = false;
  if (q) {
    where.OR = [
      { id: { contains: q } },
      { name: { contains: q } },
      { email: { contains: q } },
      { subscription_id: { contains: q } },
      { owner: { email: { contains: q } } },
      { owner: { name: { contains: q } } },
      { owner: { id: { contains: q } } },
    ];
  }
  return where;
}

const SUBSCRIPTION_SELECT = {
  ...OWNER_SELECT,
  created_at: true,
  updated_at: true,
  ...BILLING_STATE_SELECT,
} satisfies Prisma.WorkspaceSelect;

router.get('/subscriptions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const where = subscriptionWhere(req);
    const [rows, total, names] = await Promise.all([
      prisma.workspace.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip,
        take: pageSize,
        select: SUBSCRIPTION_SELECT,
      }),
      prisma.workspace.count({ where }),
      planNameMap(),
    ]);

    const [statuses, providers] = await Promise.all([
      prisma.workspace.groupBy({ by: ['subscription_status'], _count: { _all: true } }),
      prisma.workspace.groupBy({ by: ['billing_provider'], _count: { _all: true } }),
    ]);

    res.json({
      subscriptions: rows.map((w) => subscriptionRow(w, names)),
      total,
      page,
      pageSize,
      // Filter vocabularies come from the data, so the UI never offers a status
      // that cannot match anything.
      facets: {
        statuses: statuses.map((s) => ({ key: s.subscription_status, count: s._count._all })),
        providers: providers.map((p) => ({ key: p.billing_provider, count: p._count._all })),
        plans: [...names].map(([key, name]) => ({ key, name })),
      },
    });
  } catch (error) {
    console.error('[adminBilling] list subscriptions failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load subscriptions.');
  }
});

router.get('/subscriptions/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.workspace.findMany({
      where: subscriptionWhere(req),
      orderBy: { updated_at: 'desc' },
      take: EXPORT_ROW_CAP,
      select: SUBSCRIPTION_SELECT,
    });
    const names = await planNameMap();
    const records = rows.map((w) => {
      const r = subscriptionRow(w, names);
      return {
        workspace_id: r.workspace_id,
        workspace_name: r.workspace_name,
        user_email: r.user_email ?? '',
        plan_key: r.plan_key,
        effective_plan: r.effective_plan,
        subscription_status: r.subscription_status,
        payment_status: r.payment_status,
        billing_provider: r.billing_provider,
        current_period_start: r.current_period_start?.toISOString() ?? '',
        current_period_end: r.current_period_end?.toISOString() ?? '',
        cancel_at_period_end: r.cancel_at_period_end,
        manual_override: r.manual_override,
        manual_override_reason: r.manual_override_reason ?? '',
        created_at: r.created_at.toISOString(),
      };
    });
    await writeAudit(req, 'billing.subscriptions.export', null, { count: records.length });
    sendCsv(res, 'subscriptions', Object.keys(records[0] ?? { workspace_id: '' }), records);
  } catch (error) {
    console.error('[adminBilling] export subscriptions failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not export subscriptions.');
  }
});

/** One account's full billing picture: state, history, money, cards (§8, §58). */
router.get('/subscriptions/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: SUBSCRIPTION_SELECT,
    });
    if (!ws) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');

    const [names, events, payments, invoices, cards, credit, periods] = await Promise.all([
      planNameMap(),
      prisma.subscriptionEvent.findMany({
        where: { workspace_id: ws.id },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      prisma.payment.findMany({
        where: { workspace_id: ws.id },
        orderBy: { created_at: 'desc' },
        take: 25,
        include: { refunds: true },
      }),
      prisma.invoice.findMany({
        where: { workspace_id: ws.id },
        orderBy: { issued_at: 'desc' },
        take: 25,
      }),
      prisma.paymentMethod.findMany({
        where: { workspace_id: ws.id },
        orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
        select: CARD_SELECT,
      }),
      creditBalance(req.params.id),
      prisma.subscription.findMany({
        where: { workspace_id: ws.id },
        orderBy: { created_at: 'desc' },
        take: 25,
        include: { plan: { select: { key: true, name: true } } },
      }),
    ]);

    res.json({
      subscription: subscriptionRow(ws, names),
      events: events.map((e) => ({
        id: e.id,
        event: e.event,
        source: e.source,
        from_plan: e.from_plan,
        to_plan: e.to_plan,
        admin_id: e.admin_id,
        reason: e.reason,
        payment_id: e.payment_id,
        created_at: e.created_at,
        before: e.before,
        after: e.after,
      })),
      payments: payments.map(paymentRow),
      invoices: invoices.map(invoiceRow),
      // Masked metadata only — §58 explicitly forbids full card data here.
      payment_methods: cards.map(cardView),
      credit: { balance_cents: credit, balance_label: formatMoney(credit) },
      periods: periods.map((s) => ({
        id: s.id,
        plan_key: s.plan?.key ?? null,
        plan_name: s.plan?.name ?? null,
        status: s.status,
        source: s.source,
        provider: s.provider,
        interval: s.interval,
        amount_cents: s.amount_cents,
        amount_label: formatMoney(s.amount_cents, s.currency),
        current_period_start: s.current_period_start,
        current_period_end: s.current_period_end,
        canceled_at: s.canceled_at,
        cancel_reason: s.cancel_reason,
        manual_override: s.manual_override,
        created_at: s.created_at,
      })),
    });
  } catch (error) {
    console.error('[adminBilling] subscription detail failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the subscription.');
  }
});

/**
 * §35/§36/§59 — grant or remove a plan by hand.
 *
 * The reason is mandatory and there is no code path from here to a Payment row:
 * `manualOverride()` writes `payment_status = 'none'` and the `manual_override_*`
 * fields, so revenue reports can always separate a comped account from a paying
 * one. `confirm: true` is required in the body because this changes what a
 * customer is charged for and what they can use.
 */
router.post('/subscriptions/:id/override', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required for a manual plan change.');
    if (req.body?.confirm !== true) {
      return fail(res, 400, 'CONFIRM_REQUIRED', 'Confirm the change before it is applied.');
    }
    const planKey = trimmed(req.body?.plan_key, 40);
    if (!planKey) return fail(res, 400, 'PLAN_REQUIRED', 'Pick a plan.');

    const before = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, ...BILLING_STATE_SELECT },
    });
    if (!before) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');

    let expiresAt: Date | null = null;
    if (req.body?.expires_at) {
      const d = new Date(req.body.expires_at);
      if (isNaN(d.getTime())) return fail(res, 400, 'INVALID_DATE', 'Expiry is not a valid date.');
      if (d.getTime() <= Date.now()) return fail(res, 400, 'INVALID_DATE', 'Expiry must be in the future.');
      expiresAt = d;
    }

    const result = await manualOverride({
      workspace_id: before.id,
      plan_key: planKey,
      admin_id: req.user!.userId,
      admin_email: req.user?.email ?? null,
      reason,
      expires_at: expiresAt,
    });
    if (!result.ok) return fail(res, 400, 'OVERRIDE_FAILED', result.detail ?? 'Could not change the plan.');

    const after = await prisma.workspace.findUnique({
      where: { id: before.id },
      select: BILLING_STATE_SELECT,
    });
    await writeAudit(req, 'billing.plan.manual_override', {
      target_type: 'workspace',
      target_id: before.id,
      target_label: before.name,
      reason,
      before,
      after,
      severity: 'critical',
      metadata: { plan_key: planKey, expires_at: expiresAt?.toISOString() ?? null },
    });

    const names = await planNameMap();
    res.json({
      success: true,
      // Stated explicitly: no money moved. §59.
      payment_created: false,
      manual_override: isPaidPlan(planKey),
      subscription: after
        ? subscriptionRow(
            { ...before, ...after, created_at: new Date(), updated_at: new Date() },
            names,
          )
        : null,
      message: isPaidPlan(planKey)
        ? `Granted ${names.get(planKey) ?? planKey} without a payment. Recorded as a manual override.`
        : `Moved to ${names.get(planKey) ?? planKey}.`,
    });
  } catch (error) {
    console.error('[adminBilling] manual override failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not change the plan.');
  }
});

/** §8 — cancel. Defaults to end-of-period, because cutting access off after
 *  taking the money is theft; `immediate: true` is the deliberate exception. */
router.post('/subscriptions/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required to cancel a subscription.');
    const before = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, ...BILLING_STATE_SELECT },
    });
    if (!before) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');

    const immediate = req.body?.immediate === true;
    const result = await cancelSubscription({
      workspace_id: before.id,
      at_period_end: !immediate,
      reason,
      source: 'admin',
      admin_id: req.user!.userId,
    });
    if (!result.ok) return fail(res, 400, 'CANCEL_FAILED', result.detail ?? 'Could not cancel.');

    const after = await prisma.workspace.findUnique({
      where: { id: before.id },
      select: BILLING_STATE_SELECT,
    });
    await writeAudit(req, 'billing.subscription.cancel', {
      target_type: 'workspace',
      target_id: before.id,
      target_label: before.name,
      reason,
      before,
      after,
      severity: 'warning',
      metadata: { immediate },
    });
    res.json({
      success: true,
      immediate,
      message: immediate
        ? 'Cancelled immediately — the account is on the free plan now.'
        : 'Cancelled at period end. Access continues until the paid period runs out.',
    });
  } catch (error) {
    console.error('[adminBilling] cancel failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not cancel the subscription.');
  }
});

/** Undo a pending end-of-period cancellation while the period is still open. */
router.post('/subscriptions/:id/resume', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required.');
    const before = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, ...BILLING_STATE_SELECT },
    });
    if (!before) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    if (!before.cancel_at_period_end) {
      return fail(res, 409, 'NOT_CANCELLING', 'This subscription is not set to cancel.');
    }
    // Resuming cannot revive a period that has already run out — that needs a
    // payment or an override, not a flag flip.
    if (before.current_period_end && before.current_period_end.getTime() <= Date.now()) {
      return fail(res, 409, 'PERIOD_ENDED', 'The paid period has already ended. Use a manual override or a new payment.');
    }

    const after = await prisma.workspace.update({
      where: { id: before.id },
      data: { cancel_at_period_end: false, subscription_status: 'active' },
      select: BILLING_STATE_SELECT,
    });
    await writeSubscriptionEvent({
      workspace_id: before.id,
      event: 'reactivated',
      source: 'admin',
      from_plan: before.plan_key,
      to_plan: after.plan_key,
      admin_id: req.user!.userId,
      reason,
      before,
      after,
    });
    await writeAudit(req, 'billing.subscription.resume', {
      target_type: 'workspace',
      target_id: before.id,
      target_label: before.name,
      reason,
      before,
      after,
      severity: 'warning',
    });
    res.json({ success: true, message: 'Cancellation withdrawn — the subscription renews as normal.' });
  } catch (error) {
    console.error('[adminBilling] resume failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not resume the subscription.');
  }
});

/** §8 — extend the paid period (goodwill, support resolution, comped downtime). */
router.post('/subscriptions/:id/extend', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required to extend a period.');
    const days = Number(req.body?.days);
    if (!Number.isFinite(days) || days < 1 || days > 730) {
      return fail(res, 400, 'INVALID_DAYS', 'Extend by 1–730 days.');
    }
    const before = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, ...BILLING_STATE_SELECT },
    });
    if (!before) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');
    if (!isPaidPlan(before.plan_key)) {
      return fail(res, 409, 'NOT_PAID', 'There is no paid period to extend on a free plan.');
    }

    // Extend from whichever is later: the existing end, or now. Extending an
    // already-lapsed period from its old end would grant nothing.
    const base = before.current_period_end && before.current_period_end.getTime() > Date.now()
      ? before.current_period_end
      : new Date();
    const end = new Date(base.getTime() + Math.round(days) * 86_400_000);
    const after = await prisma.workspace.update({
      where: { id: before.id },
      data: {
        current_period_end: end,
        subscription_status: 'active',
        current_period_start: before.current_period_start ?? new Date(),
      },
      select: BILLING_STATE_SELECT,
    });
    await writeSubscriptionEvent({
      workspace_id: before.id,
      event: 'renewed',
      source: 'admin',
      from_plan: before.plan_key,
      to_plan: after.plan_key,
      admin_id: req.user!.userId,
      reason: `extended ${Math.round(days)} day(s): ${reason}`,
      before,
      after,
    });
    await writeAudit(req, 'billing.subscription.extend', {
      target_type: 'workspace',
      target_id: before.id,
      target_label: before.name,
      reason,
      before,
      after,
      severity: 'warning',
      metadata: { days: Math.round(days), new_period_end: end.toISOString() },
    });
    res.json({
      success: true,
      current_period_end: end,
      message: `Period extended to ${end.toISOString().slice(0, 10)}.`,
    });
  } catch (error) {
    console.error('[adminBilling] extend failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not extend the period.');
  }
});

// ── §10 payments ─────────────────────────────────────────────────────────────

type PaymentWithRefunds = Prisma.PaymentGetPayload<{ include: { refunds: true } }> & {
  workspace?: OwnerShape | null;
};

/** One payment as the payments table and the account tabs render it (§10). */
function paymentRow(p: PaymentWithRefunds) {
  const refunded = p.refunded_cents;
  return {
    // Same rule as invoiceRow: the relation is optional on some reads, the
    // `workspace_id` column never is, so the explicit value wins.
    ...accountOf(p.workspace),
    workspace_id: p.workspace_id,
    id: p.id,
    provider: p.provider,
    // The provider's own id, so support can match a row against the provider
    // dashboard without asking the customer for anything.
    provider_ref: p.provider_ref,
    status: p.status,
    amount_cents: p.amount_cents,
    amount_label: formatMoney(p.amount_cents, p.currency),
    currency: p.currency,
    refunded_cents: refunded,
    refunded_label: refunded ? formatMoney(refunded, p.currency) : null,
    refundable_cents: Math.max(0, p.amount_cents - refunded),
    plan_key: p.plan_key,
    kind: p.kind,
    description: p.description,
    failure_code: p.failure_code,
    failure_message: p.failure_message,
    invoice_id: p.invoice_id,
    created_at: p.created_at,
    succeeded_at: p.succeeded_at,
    failed_at: p.failed_at,
    refunds: p.refunds.map((r) => ({
      id: r.id,
      amount_cents: r.amount_cents,
      amount_label: formatMoney(r.amount_cents, r.currency),
      status: r.status,
      reason: r.reason,
      admin_id: r.admin_id,
      created_at: r.created_at,
      settled_at: r.settled_at,
    })),
  };
}

function paymentWhere(req: AuthenticatedRequest): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {};
  const status = trimmed(req.query.status);
  const provider = trimmed(req.query.provider);
  const plan = trimmed(req.query.plan);
  const kind = trimmed(req.query.kind);
  const workspaceId = trimmed(req.query.workspaceId);
  const userId = trimmed(req.query.userId);
  const q = trimmed(req.query.q);
  const created = dateFilter(req);
  const min = centsOf(req.query.minCents);
  const max = centsOf(req.query.maxCents);

  if (status && status !== 'all') where.status = status;
  if (provider && provider !== 'all') where.provider = provider;
  if (plan && plan !== 'all') where.plan_key = plan;
  if (kind && kind !== 'all') where.kind = kind;
  if (workspaceId) where.workspace_id = workspaceId;
  if (userId) where.workspace = { owner_id: userId };
  if (created) where.created_at = created;
  if (min !== null || max !== null) {
    where.amount_cents = {
      ...(min !== null ? { gte: min } : {}),
      ...(max !== null ? { lte: max } : {}),
    };
  }
  if (q) {
    where.OR = [
      { id: { contains: q } },
      { provider_ref: { contains: q } },
      { description: { contains: q } },
      { invoice_id: { contains: q } },
      { workspace: { id: { contains: q } } },
      { workspace: { name: { contains: q } } },
      { workspace: { owner: { email: { contains: q } } } },
    ];
  }
  return where;
}

router.get('/payments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const where = paymentWhere(req);
    const [rows, total, sums, statuses] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: { refunds: true, workspace: { select: OWNER_SELECT } },
      }),
      prisma.payment.count({ where }),
      // Totals for the current filter, computed in SQL rather than from the page.
      prisma.payment.aggregate({
        where: { ...where, status: { in: ['succeeded', 'partially_refunded', 'refunded'] } },
        _sum: { amount_cents: true, refunded_cents: true },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    const collected = sums._sum.amount_cents ?? 0;
    const refunded = sums._sum.refunded_cents ?? 0;
    res.json({
      payments: rows.map(paymentRow),
      total,
      page,
      pageSize,
      totals: {
        succeeded_count: sums._count._all,
        collected_cents: collected,
        collected_label: formatMoney(collected),
        refunded_cents: refunded,
        refunded_label: formatMoney(refunded),
        net_cents: collected - refunded,
        net_label: formatMoney(collected - refunded),
      },
      facets: { statuses: statuses.map((s) => ({ key: s.status, count: s._count._all })) },
    });
  } catch (error) {
    console.error('[adminBilling] list payments failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load payments.');
  }
});

router.get('/payments/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.payment.findMany({
      where: paymentWhere(req),
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
      include: { refunds: true, workspace: { select: OWNER_SELECT } },
    });
    const records = rows.map((p) => {
      const r = paymentRow(p);
      return {
        id: r.id,
        created_at: r.created_at.toISOString(),
        status: r.status,
        provider: r.provider,
        provider_ref: r.provider_ref ?? '',
        amount_cents: r.amount_cents,
        currency: r.currency,
        refunded_cents: r.refunded_cents,
        plan_key: r.plan_key ?? '',
        kind: r.kind,
        workspace_id: r.workspace_id ?? '',
        user_email: r.user_email ?? '',
        invoice_id: r.invoice_id ?? '',
        failure_code: r.failure_code ?? '',
        succeeded_at: r.succeeded_at?.toISOString() ?? '',
      };
    });
    await writeAudit(req, 'billing.payments.export', null, { count: records.length });
    sendCsv(res, 'payments', Object.keys(records[0] ?? { id: '' }), records);
  } catch (error) {
    console.error('[adminBilling] export payments failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not export payments.');
  }
});

router.get('/payments/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const p = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { refunds: true, workspace: { select: OWNER_SELECT } },
    });
    if (!p) return fail(res, 404, 'NOT_FOUND', 'Payment not found.');

    const [invoice, session, events] = await Promise.all([
      p.invoice_id
        ? prisma.invoice.findUnique({ where: { id: p.invoice_id }, include: { items: true } })
        : Promise.resolve(null),
      prisma.checkoutSession.findFirst({
        where: { payment_id: p.id },
        orderBy: { created_at: 'desc' },
      }),
      prisma.subscriptionEvent.findMany({
        where: { payment_id: p.id },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    res.json({
      payment: paymentRow(p),
      invoice: invoice ? invoiceRow(invoice) : null,
      checkout_session: session
        ? {
            id: session.id,
            status: session.status,
            provider: session.provider,
            provider_ref: session.provider_ref,
            plan_key: session.plan_key,
            amount_cents: session.amount_cents,
            created_at: session.created_at,
            completed_at: session.completed_at,
            expires_at: session.expires_at,
          }
        : null,
      subscription_events: events,
      // The verified provider payload, for support and forensics. It is whatever
      // the provider sent, so it is shown as-is rather than reinterpreted.
      provider_event: p.provider_event,
    });
  } catch (error) {
    console.error('[adminBilling] payment detail failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the payment.');
  }
});

// ── §10 refunds ──────────────────────────────────────────────────────────────

/**
 * The canonical refund endpoint (§47 names it `POST /admin/api/refunds` and binds
 * it to the refund permission). `requirePermission` is stated here as well as in
 * the gate table so the rule is visible at the call site — a future rename of the
 * path can't silently downgrade it to plain `billing.manage`.
 *
 * This records a refund *we already issued or are issuing out of band*: there is
 * no provider API call here, because the credentials to move money live with the
 * provider dashboard and a half-completed remote call would leave the ledger
 * lying. `provider_ref` carries the provider's refund id when the operator has it.
 */
router.post('/refunds', requirePermission('refunds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required for every refund.');
    const paymentId = trimmed(req.body?.payment_id, 80);
    if (!paymentId) return fail(res, 400, 'PAYMENT_REQUIRED', 'Which payment is being refunded?');

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { refunds: true, workspace: { select: OWNER_SELECT } },
    });
    if (!payment) return fail(res, 404, 'NOT_FOUND', 'Payment not found.');

    const remaining = payment.amount_cents - payment.refunded_cents;
    // Omitted amount = refund the rest. An explicit amount is capped at the
    // remainder by recordRefund(), so no sequence of calls can over-refund.
    const requested = centsOf(req.body?.amount_cents);
    const amount = requested === null || requested <= 0 ? remaining : requested;
    if (remaining <= 0) return fail(res, 409, 'ALREADY_REFUNDED', 'This payment is already fully refunded.');

    const before = { status: payment.status, refunded_cents: payment.refunded_cents };
    const result = await recordRefund({
      payment_id: payment.id,
      amount_cents: amount,
      reason,
      admin_id: req.user!.userId,
      provider_ref: trimmed(req.body?.provider_ref, 120) || null,
      revoke_plan: req.body?.revoke_plan === true,
    });
    if (!result.ok) return fail(res, 400, 'REFUND_FAILED', result.detail ?? 'Could not record the refund.');

    const after = await prisma.payment.findUnique({
      where: { id: payment.id },
      select: { status: true, refunded_cents: true },
    });
    await writeAudit(req, 'billing.refund.create', {
      target_type: 'payment',
      target_id: payment.id,
      target_label: payment.workspace?.name ?? payment.workspace_id,
      reason,
      before,
      after,
      severity: 'critical',
      metadata: {
        amount_cents: Math.min(amount, remaining),
        refund_id: result.refund_id,
        revoke_plan: req.body?.revoke_plan === true,
        workspace_id: payment.workspace_id,
      },
    });

    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { refunds: true, workspace: { select: OWNER_SELECT } },
    });
    res.status(201).json({
      success: true,
      refund_id: result.refund_id,
      payment: fresh ? paymentRow(fresh) : null,
      message: `Refunded ${formatMoney(Math.min(amount, remaining), payment.currency)}.`,
    });
  } catch (error) {
    console.error('[adminBilling] refund failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not record the refund.');
  }
});

router.get('/refunds', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const q = trimmed(req.query.q);
    const status = trimmed(req.query.status);
    const created = dateFilter(req);
    const where: Prisma.RefundWhereInput = {};
    if (status && status !== 'all') where.status = status;
    if (created) where.created_at = created;
    if (q) {
      where.OR = [
        { id: { contains: q } },
        { payment_id: { contains: q } },
        { provider_ref: { contains: q } },
        { reason: { contains: q } },
        { payment: { workspace: { owner: { email: { contains: q } } } } },
      ];
    }

    const [rows, total, sum] = await Promise.all([
      prisma.refund.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: {
          payment: {
            select: {
              id: true,
              provider_ref: true,
              amount_cents: true,
              plan_key: true,
              workspace: { select: OWNER_SELECT },
            },
          },
        },
      }),
      prisma.refund.count({ where }),
      prisma.refund.aggregate({ where: { ...where, status: 'succeeded' }, _sum: { amount_cents: true } }),
    ]);

    const admins = await adminNameMap(rows.map((r) => r.admin_id));
    res.json({
      refunds: rows.map((r) => ({
        id: r.id,
        payment_id: r.payment_id,
        provider: r.provider,
        provider_ref: r.provider_ref,
        amount_cents: r.amount_cents,
        amount_label: formatMoney(r.amount_cents, r.currency),
        currency: r.currency,
        status: r.status,
        reason: r.reason,
        admin_id: r.admin_id,
        admin_email: r.admin_id ? admins.get(r.admin_id) ?? null : null,
        created_at: r.created_at,
        settled_at: r.settled_at,
        payment_amount_cents: r.payment?.amount_cents ?? null,
        plan_key: r.payment?.plan_key ?? null,
        ...accountOf(r.payment?.workspace),
      })),
      total,
      page,
      pageSize,
      totals: {
        refunded_cents: sum._sum.amount_cents ?? 0,
        refunded_label: formatMoney(sum._sum.amount_cents ?? 0),
      },
    });
  } catch (error) {
    console.error('[adminBilling] list refunds failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load refunds.');
  }
});

/** admin id → email, so ledger rows can name the actor without an N+1 per row. */
async function adminNameMap(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, email: true },
  });
  return new Map(rows.map((r) => [r.id, r.email]));
}

// ── §11 invoices ─────────────────────────────────────────────────────────────

type InvoiceShape = {
  id: string;
  number: string | null;
  workspace_id: string;
  period_start: Date;
  period_end: Date;
  amount_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  credit_cents: number;
  currency: string;
  status: string;
  issued_at: Date;
  paid_at: Date | null;
  due_at: Date | null;
  payment_id: string | null;
  notes: string | null;
  pdf_path: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  marked_paid_by: string | null;
  marked_paid_reason: string | null;
  sent_count: number;
  last_sent_at: Date | null;
  items?: { id: string; description: string; quantity: number; unit_cents: number; amount_cents: number; kind: string }[];
  workspace?: OwnerShape | null;
};

function invoiceRow(inv: InvoiceShape) {
  return {
    // Account identity first: the explicit `workspace_id` below wins, because the
    // column is always present while the relation is only included on some reads.
    ...accountOf(inv.workspace),
    id: inv.id,
    number: inv.number,
    workspace_id: inv.workspace_id,
    period_start: inv.period_start,
    period_end: inv.period_end,
    amount_cents: inv.amount_cents,
    amount_label: formatMoney(inv.amount_cents, inv.currency),
    subtotal_cents: inv.subtotal_cents,
    tax_cents: inv.tax_cents,
    discount_cents: inv.discount_cents,
    credit_cents: inv.credit_cents,
    currency: inv.currency,
    status: inv.status,
    issued_at: inv.issued_at,
    paid_at: inv.paid_at,
    due_at: inv.due_at,
    payment_id: inv.payment_id,
    notes: inv.notes,
    // NULL until a PDF renderer exists; the download endpoint serves text, and
    // nothing here claims a file is on disk when it is not.
    pdf_path: inv.pdf_path,
    voided_at: inv.voided_at,
    voided_by: inv.voided_by,
    // Present only when an admin settled it outside the provider (§11).
    marked_paid_by: inv.marked_paid_by,
    marked_paid_reason: inv.marked_paid_reason,
    sent_count: inv.sent_count,
    last_sent_at: inv.last_sent_at,
    items: inv.items?.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unit_cents: i.unit_cents,
      amount_cents: i.amount_cents,
      amount_label: formatMoney(i.amount_cents, inv.currency),
      kind: i.kind,
    })),
  };
}

function invoiceWhere(req: AuthenticatedRequest): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {};
  const status = trimmed(req.query.status);
  const workspaceId = trimmed(req.query.workspaceId);
  const userId = trimmed(req.query.userId);
  const q = trimmed(req.query.q);
  const issued = dateFilter(req);
  if (status && status !== 'all') where.status = status;
  if (workspaceId) where.workspace_id = workspaceId;
  if (userId) where.workspace = { owner_id: userId };
  if (issued) where.issued_at = issued;
  if (q) {
    where.OR = [
      { id: { contains: q } },
      { number: { contains: q } },
      { payment_id: { contains: q } },
      { workspace: { name: { contains: q } } },
      { workspace: { owner: { email: { contains: q } } } },
    ];
  }
  return where;
}

router.get('/invoices', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const where = invoiceWhere(req);
    const [rows, total, statuses, paid, outstanding] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { issued_at: 'desc' },
        skip,
        take: pageSize,
        include: { workspace: { select: OWNER_SELECT } },
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.invoice.aggregate({ where: { ...where, status: 'paid' }, _sum: { amount_cents: true } }),
      prisma.invoice.aggregate({
        where: { ...where, status: { in: ['pending', 'failed'] } },
        _sum: { amount_cents: true },
      }),
    ]);
    res.json({
      invoices: rows.map(invoiceRow),
      total,
      page,
      pageSize,
      totals: {
        paid_cents: paid._sum.amount_cents ?? 0,
        paid_label: formatMoney(paid._sum.amount_cents ?? 0),
        outstanding_cents: outstanding._sum.amount_cents ?? 0,
        outstanding_label: formatMoney(outstanding._sum.amount_cents ?? 0),
      },
      facets: { statuses: statuses.map((s) => ({ key: s.status, count: s._count._all })) },
    });
  } catch (error) {
    console.error('[adminBilling] list invoices failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load invoices.');
  }
});

router.get('/invoices/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.invoice.findMany({
      where: invoiceWhere(req),
      orderBy: { issued_at: 'desc' },
      take: EXPORT_ROW_CAP,
      include: { workspace: { select: OWNER_SELECT } },
    });
    const records = rows.map((inv) => ({
      id: inv.id,
      number: inv.number ?? '',
      issued_at: inv.issued_at.toISOString(),
      status: inv.status,
      workspace_id: inv.workspace_id,
      user_email: inv.workspace?.owner?.email ?? '',
      subtotal_cents: inv.subtotal_cents,
      discount_cents: inv.discount_cents,
      credit_cents: inv.credit_cents,
      tax_cents: inv.tax_cents,
      amount_cents: inv.amount_cents,
      currency: inv.currency,
      paid_at: inv.paid_at?.toISOString() ?? '',
      payment_id: inv.payment_id ?? '',
      marked_paid_by: inv.marked_paid_by ?? '',
      voided_at: inv.voided_at?.toISOString() ?? '',
    }));
    await writeAudit(req, 'billing.invoices.export', null, { count: records.length });
    sendCsv(res, 'invoices', Object.keys(records[0] ?? { id: '' }), records);
  } catch (error) {
    console.error('[adminBilling] export invoices failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not export invoices.');
  }
});

router.get('/invoices/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { items: true, workspace: { select: { ...OWNER_SELECT, billing_profile: true } } },
    });
    if (!inv) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    const payment = inv.payment_id
      ? await prisma.payment.findUnique({
          where: { id: inv.payment_id },
          include: { refunds: true },
        })
      : null;
    res.json({
      invoice: invoiceRow(inv),
      payment: payment ? paymentRow(payment) : null,
      billing_profile: inv.workspace?.billing_profile ?? null,
    });
  } catch (error) {
    console.error('[adminBilling] invoice detail failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the invoice.');
  }
});

/** Plain-text invoice download — the same body the customer-facing route serves. */
router.get('/invoices/:id/download', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        workspace: { select: { name: true, email: true, owner: { select: { email: true } }, billing_profile: true } },
      },
    });
    if (!inv) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    const billTo = inv.workspace?.billing_profile?.company ?? inv.workspace?.email ?? inv.workspace?.owner?.email ?? null;
    const body = renderInvoiceText(inv, inv.workspace?.name ?? inv.workspace_id, billTo);
    await writeAudit(req, 'billing.invoice.download', {
      target_type: 'invoice',
      target_id: inv.id,
      target_label: inv.number ?? inv.id,
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number ?? inv.id}.txt"`);
    res.send(body);
  } catch (error) {
    console.error('[adminBilling] invoice download failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not render the invoice.');
  }
});

/** §11 — void an invoice. Terminal: a voided invoice is never re-opened, a
 *  correction is a new invoice, which is what keeps the numbering auditable. */
router.post('/invoices/:id/void', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required to void an invoice.');
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!inv) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    if (inv.status === 'void') return fail(res, 409, 'ALREADY_VOID', 'This invoice is already void.');
    if (inv.status === 'paid') {
      // Voiding a paid invoice would erase the record of money we actually took.
      return fail(res, 409, 'ALREADY_PAID', 'A paid invoice cannot be voided — refund the payment instead.');
    }

    const before = { status: inv.status, notes: inv.notes };
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        status: 'void',
        voided_at: new Date(),
        voided_by: req.user!.userId,
        notes: inv.notes ? `${inv.notes}\nVoided: ${reason}` : `Voided: ${reason}`,
      },
    });
    await writeAudit(req, 'billing.invoice.void', {
      target_type: 'invoice',
      target_id: inv.id,
      target_label: inv.number ?? inv.id,
      reason,
      before,
      after: { status: updated.status },
      severity: 'critical',
      metadata: { workspace_id: inv.workspace_id, amount_cents: inv.amount_cents },
    });
    res.json({ success: true, invoice: invoiceRow(updated), message: 'Invoice voided.' });
  } catch (error) {
    console.error('[adminBilling] void invoice failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not void the invoice.');
  }
});

/**
 * §11 — mark paid, for authorized manual settlements only (bank transfer, cash,
 * a provider payment that arrived out of band).
 *
 * It records who and why, and it does NOT create a Payment row: inventing one
 * would put money in the revenue reports that no provider ever confirmed. The
 * invoice carries `marked_paid_by`, so every report can separate these from
 * webhook-verified revenue.
 */
router.post('/invoices/:id/mark-paid', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required to mark an invoice paid.');
    if (req.body?.confirm !== true) {
      return fail(res, 400, 'CONFIRM_REQUIRED', 'Confirm before marking an invoice paid.');
    }
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!inv) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    if (inv.status === 'paid') return fail(res, 409, 'ALREADY_PAID', 'This invoice is already paid.');
    if (inv.status === 'void') return fail(res, 409, 'VOIDED', 'A voided invoice cannot be marked paid.');

    const before = { status: inv.status, paid_at: inv.paid_at };
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        status: 'paid',
        paid_at: new Date(),
        marked_paid_by: req.user!.userId,
        marked_paid_reason: reason,
      },
    });
    await writeAudit(req, 'billing.invoice.mark_paid', {
      target_type: 'invoice',
      target_id: inv.id,
      target_label: inv.number ?? inv.id,
      reason,
      before,
      after: { status: updated.status, paid_at: updated.paid_at },
      severity: 'critical',
      metadata: { workspace_id: inv.workspace_id, amount_cents: inv.amount_cents },
    });
    res.json({
      success: true,
      invoice: invoiceRow(updated),
      // Said out loud so nobody expects the plan to move: marking an invoice paid
      // settles the document, it does not activate a subscription (§34).
      payment_created: false,
      subscription_changed: false,
      message: 'Invoice marked paid. No payment record was created and no plan changed.',
    });
  } catch (error) {
    console.error('[adminBilling] mark invoice paid failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not mark the invoice paid.');
  }
});

/**
 * §11 — send / resend the invoice to the billing contact.
 *
 * Delivery is queued rather than claimed: the row lands in `email_logs` with
 * status `queued`, and the mailer sends it when SMTP is configured. The response
 * says which of those happened instead of reporting a success the platform cannot
 * yet guarantee.
 */
router.post('/invoices/:id/send', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        workspace: { select: { name: true, email: true, owner: { select: { id: true, email: true } } } },
      },
    });
    if (!inv) return fail(res, 404, 'NOT_FOUND', 'Invoice not found.');
    if (inv.status === 'void') return fail(res, 409, 'VOIDED', 'A voided invoice is not sent.');

    const to = trimmed(req.body?.to, 200) || inv.workspace?.email || inv.workspace?.owner?.email || '';
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return fail(res, 400, 'NO_RECIPIENT', 'No valid billing email on this account.');
    }

    const log = await prisma.emailLog.create({
      data: {
        to_email: to,
        subject: `Invoice ${inv.number ?? inv.id} — ${formatMoney(inv.amount_cents, inv.currency)}`,
        template_key: 'invoice',
        status: 'queued',
        user_id: inv.workspace?.owner?.id ?? null,
        kind: 'transactional',
      },
    });
    const updated = await prisma.invoice.update({
      where: { id: inv.id },
      data: { sent_count: { increment: 1 }, last_sent_at: new Date() },
    });
    await writeAudit(req, 'billing.invoice.send', {
      target_type: 'invoice',
      target_id: inv.id,
      target_label: inv.number ?? inv.id,
      metadata: { to, email_log_id: log.id, attempt: updated.sent_count },
    });
    res.json({
      success: true,
      queued: true,
      to,
      email_log_id: log.id,
      sent_count: updated.sent_count,
      message: `Queued for ${to}. It goes out on the next mail run.`,
    });
  } catch (error) {
    console.error('[adminBilling] send invoice failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not queue the invoice.');
  }
});

// ── §6 cards on file ─────────────────────────────────────────────────────────

/**
 * Every saved payment method across the platform, masked.
 *
 * There is nothing to redact here because there is nothing to redact in the
 * table: the schema stores a provider token plus brand/last4/expiry, and
 * `provider_ref` (the token) is not in CARD_SELECT, so it cannot reach a
 * response even by accident. §6/§60 test 11: "only masked card metadata visible".
 */
router.get('/cards', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const provider = trimmed(req.query.provider);
    const status = trimmed(req.query.status);
    const brand = trimmed(req.query.brand);
    const workspaceId = trimmed(req.query.workspaceId);
    const q = trimmed(req.query.q);

    const where: Prisma.PaymentMethodWhereInput = {};
    if (provider && provider !== 'all') where.provider = provider;
    if (status && status !== 'all') where.status = status;
    if (brand && brand !== 'all') where.brand = brand;
    if (workspaceId) where.workspace_id = workspaceId;
    if (q) {
      where.OR = [
        // Last four is searchable on purpose: it is how support matches a card the
        // customer reads out. Four digits identify nothing on their own.
        { last4: { contains: q } },
        { billing_name: { contains: q } },
        { workspace: { name: { contains: q } } },
        { workspace: { id: { contains: q } } },
        { workspace: { owner: { email: { contains: q } } } },
      ];
    }

    const [rows, total, brands] = await Promise.all([
      prisma.paymentMethod.findMany({
        where,
        orderBy: [{ created_at: 'desc' }],
        skip,
        take: pageSize,
        select: { ...CARD_SELECT, workspace: { select: OWNER_SELECT } },
      }),
      prisma.paymentMethod.count({ where }),
      prisma.paymentMethod.groupBy({ by: ['brand'], _count: { _all: true } }),
    ]);

    res.json({
      cards: rows.map((m) => ({ ...cardView(m), ...accountOf(m.workspace) })),
      total,
      page,
      pageSize,
      facets: { brands: brands.map((b) => ({ key: b.brand, count: b._count._all })) },
      // Contract statement for the UI, so a card table never renders an input for
      // data the platform refuses to hold.
      never_stored: ['card_number', 'cvv', 'security_code'],
    });
  } catch (error) {
    console.error('[adminBilling] list cards failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load payment methods.');
  }
});

// ── §13 credits / wallet ─────────────────────────────────────────────────────

const CREDIT_KINDS: CreditKind[] = ['grant', 'revoke', 'promo', 'refund', 'usage', 'adjustment'];

/** The ledger, newest first, with balances. Every row names an actor and a reason. */
router.get('/credits', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const workspaceId = trimmed(req.query.workspaceId);
    const kind = trimmed(req.query.kind);
    const q = trimmed(req.query.q);
    const created = dateFilter(req);

    const where: Prisma.CreditTransactionWhereInput = {};
    if (workspaceId) where.workspace_id = workspaceId;
    if (kind && kind !== 'all') where.kind = kind;
    if (created) where.created_at = created;
    if (q) {
      where.OR = [
        { workspace_id: { contains: q } },
        { reason: { contains: q } },
        { workspace: { name: { contains: q } } },
        { workspace: { owner: { email: { contains: q } } } },
      ];
    }

    const [rows, total, balances, outstanding] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: { workspace: { select: OWNER_SELECT } },
      }),
      prisma.creditTransaction.count({ where }),
      prisma.creditBalance.findMany({
        where: { balance_cents: { gt: 0 } },
        orderBy: { balance_cents: 'desc' },
        take: 50,
        include: { workspace: { select: OWNER_SELECT } },
      }),
      prisma.creditBalance.aggregate({ _sum: { balance_cents: true } }),
    ]);

    const admins = await adminNameMap(rows.map((r) => r.admin_id));
    res.json({
      transactions: rows.map((t) => ({
        id: t.id,
        amount_cents: t.amount_cents,
        amount_label: formatMoney(t.amount_cents),
        kind: t.kind,
        reason: t.reason,
        admin_id: t.admin_id,
        admin_email: t.admin_id ? admins.get(t.admin_id) ?? null : null,
        balance_after: t.balance_after,
        balance_after_label: formatMoney(t.balance_after),
        created_at: t.created_at,
        ...accountOf(t.workspace),
      })),
      total,
      page,
      pageSize,
      // Liability the platform is carrying, which is the number finance asks for.
      outstanding_cents: outstanding._sum.balance_cents ?? 0,
      outstanding_label: formatMoney(outstanding._sum.balance_cents ?? 0),
      top_balances: balances.map((b) => ({
        balance_cents: b.balance_cents,
        balance_label: formatMoney(b.balance_cents),
        updated_at: b.updated_at,
        ...accountOf(b.workspace),
      })),
      kinds: CREDIT_KINDS,
    });
  } catch (error) {
    console.error('[adminBilling] list credits failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the credit ledger.');
  }
});

/**
 * §13 — move a wallet balance. Signed cents: positive grants, negative revokes.
 * `moveCredit()` is the only writer of the balance column, so the ledger and the
 * balance can never disagree, and it refuses a move that would go below zero.
 */
router.post('/credits', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A reason is required for every credit change.');
    const workspaceId = trimmed(req.body?.workspace_id, 80);
    if (!workspaceId) return fail(res, 400, 'WORKSPACE_REQUIRED', 'Which account is this for?');
    const amount = centsOf(req.body?.amount_cents);
    if (amount === null || amount === 0) {
      return fail(res, 400, 'INVALID_AMOUNT', 'Amount must be a non-zero number of cents.');
    }
    const kind = trimmed(req.body?.kind, 20) as CreditKind;
    if (kind && !CREDIT_KINDS.includes(kind)) return fail(res, 400, 'INVALID_KIND', 'Unknown credit kind.');

    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!ws) return fail(res, 404, 'NOT_FOUND', 'Workspace not found.');

    const before = await creditBalance(ws.id);
    const result = await moveCredit({
      workspace_id: ws.id,
      amount_cents: amount,
      kind: kind || (amount > 0 ? 'grant' : 'revoke'),
      reason,
      admin_id: req.user!.userId,
    });
    if (!result.ok) return fail(res, 400, 'CREDIT_FAILED', result.detail ?? 'Could not move the balance.');

    await writeAudit(req, amount > 0 ? 'billing.credit.grant' : 'billing.credit.revoke', {
      target_type: 'workspace',
      target_id: ws.id,
      target_label: ws.name,
      reason,
      before: { balance_cents: before },
      after: { balance_cents: result.balance_cents },
      severity: 'critical',
      metadata: { amount_cents: amount, transaction_id: result.transaction_id },
    });
    res.status(201).json({
      success: true,
      balance_cents: result.balance_cents ?? 0,
      balance_label: formatMoney(result.balance_cents ?? 0),
      transaction_id: result.transaction_id,
      message: `${amount > 0 ? 'Granted' : 'Removed'} ${formatMoney(Math.abs(amount))}. Balance is now ${formatMoney(result.balance_cents ?? 0)}.`,
    });
  } catch (error) {
    console.error('[adminBilling] credit move failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not move the balance.');
  }
});

// ── §13 coupons ──────────────────────────────────────────────────────────────

const COUPON_KINDS = ['fixed', 'percent'] as const;
const COUPON_DURATIONS = ['once', 'forever', 'months'] as const;

type CouponShape = Prisma.PromoCodeGetPayload<{ include: { _count: { select: { redemptions: true } } } }>;

function couponRow(c: CouponShape) {
  const now = Date.now();
  const expired = !!c.expires_at && c.expires_at.getTime() < now;
  const notStarted = !!c.starts_at && c.starts_at.getTime() > now;
  const exhausted = c.max_redemables !== null && c._count.redemptions >= c.max_redemables;
  return {
    id: c.id,
    code: c.code,
    kind: c.kind,
    // Only one of these is meaningful per kind; both are sent so the form can
    // switch without a second request.
    amount_cents: c.amount_cents,
    amount_label: formatMoney(c.amount_cents),
    percent_off: c.percent_off,
    value_label: c.kind === 'percent' ? `${c.percent_off ?? 0}% off` : `${formatMoney(c.amount_cents)} off`,
    description: c.description,
    plan_keys: Array.isArray(c.plan_keys) ? (c.plan_keys as string[]) : [],
    duration: c.duration,
    duration_months: c.duration_months,
    active: c.active,
    starts_at: c.starts_at,
    expires_at: c.expires_at,
    max_redemables: c.max_redemables,
    redemption_count: c._count.redemptions,
    created_by: c.created_by,
    created_at: c.created_at,
    // Derived once here so every surface agrees on what "usable" means.
    usable: c.active && !expired && !notStarted && !exhausted,
    state: !c.active ? 'disabled' : expired ? 'expired' : notStarted ? 'scheduled' : exhausted ? 'exhausted' : 'active',
  };
}

const COUPON_INCLUDE = { _count: { select: { redemptions: true } } } satisfies Prisma.PromoCodeInclude;

router.get('/coupons', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const q = trimmed(req.query.q);
    const active = trimmed(req.query.active);
    const where: Prisma.PromoCodeWhereInput = {};
    if (active === 'true') where.active = true;
    if (active === 'false') where.active = false;
    if (q) where.OR = [{ code: { contains: q } }, { description: { contains: q } }];

    const [rows, total] = await Promise.all([
      prisma.promoCode.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        include: COUPON_INCLUDE,
      }),
      prisma.promoCode.count({ where }),
    ]);
    const plans = await planCatalog();
    res.json({
      coupons: rows.map(couponRow),
      total,
      page,
      pageSize,
      kinds: COUPON_KINDS,
      durations: COUPON_DURATIONS,
      plans: plans.map((p) => ({ key: p.key, name: p.name })),
    });
  } catch (error) {
    console.error('[adminBilling] list coupons failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load coupons.');
  }
});

/** Parse and validate a coupon body. Returns the data or an error code+message. */
function couponData(body: any, existing?: CouponShape):
  | { ok: true; data: Prisma.PromoCodeUncheckedCreateInput }
  | { ok: false; code: string; message: string } {
  const code = trimmed(body?.code, 40).toUpperCase().replace(/\s+/g, '');
  if (!existing && !/^[A-Z0-9_-]{3,40}$/.test(code)) {
    return { ok: false, code: 'INVALID_CODE', message: 'Code must be 3–40 characters: A–Z, 0–9, - or _.' };
  }
  const kind = trimmed(body?.kind, 10) || existing?.kind || 'fixed';
  if (!COUPON_KINDS.includes(kind as never)) {
    return { ok: false, code: 'INVALID_KIND', message: 'Kind must be fixed or percent.' };
  }
  const duration = trimmed(body?.duration, 10) || existing?.duration || 'once';
  if (!COUPON_DURATIONS.includes(duration as never)) {
    return { ok: false, code: 'INVALID_DURATION', message: 'Duration must be once, forever or months.' };
  }

  let amount = centsOf(body?.amount_cents) ?? existing?.amount_cents ?? 0;
  let percent = centsOf(body?.percent_off) ?? existing?.percent_off ?? null;
  if (kind === 'percent') {
    if (percent === null || percent < 1 || percent > 100) {
      return { ok: false, code: 'INVALID_PERCENT', message: 'Percent off must be 1–100.' };
    }
    // A percent coupon carries no cash value; keeping amount_cents at 0 stops it
    // from ever being mistaken for wallet money.
    amount = 0;
  } else {
    if (amount < 1) return { ok: false, code: 'INVALID_AMOUNT', message: 'Amount must be at least 1 cent.' };
    percent = null;
  }

  const months = centsOf(body?.duration_months);
  if (duration === 'months' && (months === null || months < 1 || months > 60)) {
    return { ok: false, code: 'INVALID_MONTHS', message: 'Repeating coupons need 1–60 months.' };
  }

  const dateOf = (v: unknown): Date | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const d = new Date(v as string);
    return isNaN(d.getTime()) ? undefined : d;
  };
  const startsAt = dateOf(body?.starts_at);
  const expiresAt = dateOf(body?.expires_at);
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    return { ok: false, code: 'INVALID_DATES', message: 'Expiry must be after the start date.' };
  }

  const max = centsOf(body?.max_redemables);
  const planKeys = Array.isArray(body?.plan_keys)
    ? body.plan_keys.map((k: unknown) => trimmed(k, 40)).filter(Boolean)
    : undefined;

  return {
    ok: true,
    data: {
      code: existing ? existing.code : code,
      kind,
      amount_cents: amount,
      percent_off: percent,
      description: trimmed(body?.description, 200) || existing?.description || null,
      duration,
      duration_months: duration === 'months' ? months : null,
      active: typeof body?.active === 'boolean' ? body.active : existing?.active ?? true,
      starts_at: startsAt === undefined ? existing?.starts_at ?? null : startsAt,
      expires_at: expiresAt === undefined ? existing?.expires_at ?? null : expiresAt,
      max_redemables: max !== null && max > 0 ? max : body?.max_redemables === null ? null : existing?.max_redemables ?? null,
      plan_keys: planKeys ?? (existing?.plan_keys as Prisma.InputJsonValue | undefined) ?? [],
    },
  };
}

router.post('/coupons', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = couponData(req.body);
    if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);

    const clash = await prisma.promoCode.findUnique({ where: { code: parsed.data.code } });
    if (clash) return fail(res, 409, 'CODE_TAKEN', 'That code already exists.');

    const created = await prisma.promoCode.create({
      data: { ...parsed.data, created_by: req.user!.userId },
      include: COUPON_INCLUDE,
    });
    await writeAudit(req, 'billing.coupon.create', {
      target_type: 'coupon',
      target_id: created.id,
      target_label: created.code,
      after: parsed.data,
      severity: 'warning',
    });
    res.status(201).json({ success: true, coupon: couponRow(created) });
  } catch (error) {
    console.error('[adminBilling] create coupon failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not create the coupon.');
  }
});

router.patch('/coupons/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await prisma.promoCode.findUnique({
      where: { id: req.params.id },
      include: COUPON_INCLUDE,
    });
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Coupon not found.');

    const parsed = couponData(req.body, existing);
    if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);
    // The code itself is immutable once created: redemptions point at this row, and
    // renaming it would rewrite history for everyone who already used it.
    const { code: _ignored, ...data } = parsed.data;

    const updated = await prisma.promoCode.update({
      where: { id: existing.id },
      data,
      include: COUPON_INCLUDE,
    });
    await writeAudit(req, 'billing.coupon.update', {
      target_type: 'coupon',
      target_id: existing.id,
      target_label: existing.code,
      reason: reasonOf(req) || null,
      before: {
        kind: existing.kind,
        amount_cents: existing.amount_cents,
        percent_off: existing.percent_off,
        active: existing.active,
        expires_at: existing.expires_at,
        max_redemables: existing.max_redemables,
      },
      after: data,
      severity: 'warning',
    });
    res.json({ success: true, coupon: couponRow(updated) });
  } catch (error) {
    console.error('[adminBilling] update coupon failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not update the coupon.');
  }
});

/** Delete only while unused; a redeemed coupon is disabled instead, so the
 *  redemption rows keep pointing at something real. */
router.delete('/coupons/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const existing = await prisma.promoCode.findUnique({
      where: { id: req.params.id },
      include: COUPON_INCLUDE,
    });
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Coupon not found.');

    if (existing._count.redemptions > 0) {
      const disabled = await prisma.promoCode.update({
        where: { id: existing.id },
        data: { active: false },
        include: COUPON_INCLUDE,
      });
      await writeAudit(req, 'billing.coupon.disable', {
        target_type: 'coupon',
        target_id: existing.id,
        target_label: existing.code,
        reason: reasonOf(req) || 'delete requested; disabled because it has redemptions',
        before: { active: true },
        after: { active: false },
        severity: 'warning',
      });
      return res.json({
        success: true,
        deleted: false,
        coupon: couponRow(disabled),
        message: `Disabled instead of deleted — ${existing._count.redemptions} account(s) already redeemed it.`,
      });
    }

    await prisma.promoCode.delete({ where: { id: existing.id } });
    await writeAudit(req, 'billing.coupon.delete', {
      target_type: 'coupon',
      target_id: existing.id,
      target_label: existing.code,
      reason: reasonOf(req) || null,
      before: { code: existing.code, kind: existing.kind, amount_cents: existing.amount_cents },
      severity: 'warning',
    });
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('[adminBilling] delete coupon failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not delete the coupon.');
  }
});

router.get('/coupons/:id/redemptions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const where = { promo_code_id: req.params.id };
    const [rows, total] = await Promise.all([
      prisma.promoRedemption.findMany({
        where,
        orderBy: { redeemed_at: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.promoRedemption.count({ where }),
    ]);
    // PromoRedemption has no workspace relation, so resolve the accounts in one
    // extra query rather than per row.
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: rows.map((r) => r.workspace_id) } },
      select: OWNER_SELECT,
    });
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    res.json({
      redemptions: rows.map((r) => ({
        id: r.id,
        redeemed_at: r.redeemed_at,
        ...accountOf(byId.get(r.workspace_id)),
      })),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('[adminBilling] coupon redemptions failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load redemptions.');
  }
});

// ── §58 one account's billing tab ────────────────────────────────────────────

/**
 * Everything the admin user-detail page needs on its Billing tab: the §37 state,
 * masked cards, payment history, invoices, the credit ledger and any checkout the
 * customer left open. §58 is the bug this closes — an admin previously could not
 * see payment methods, subscription state, payment status or invoices for a user.
 */
router.get('/users/:id/billing', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true, status: true, plan: { select: { key: true, name: true } } },
    });
    if (!user) return fail(res, 404, 'NOT_FOUND', 'User not found.');

    // Billing follows workspace ownership: an account can own more than one.
    const owned = await prisma.workspace.findMany({
      where: { owner_id: user.id },
      orderBy: { created_at: 'asc' },
      select: SUBSCRIPTION_SELECT,
    });
    const ids = owned.map((w) => w.id);
    const names = await planNameMap();

    if (ids.length === 0) {
      return res.json({
        user,
        workspaces: [],
        payments: [],
        invoices: [],
        payment_methods: [],
        credit: { balance_cents: 0, balance_label: formatMoney(0), transactions: [] },
        events: [],
        open_checkouts: [],
        never_stored: ['card_number', 'cvv', 'security_code'],
      });
    }

    const [cards, payments, invoices, balances, ledger, events, checkouts] = await Promise.all([
      prisma.paymentMethod.findMany({
        where: { workspace_id: { in: ids } },
        orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
        select: { ...CARD_SELECT, workspace_id: true },
      }),
      prisma.payment.findMany({
        where: { workspace_id: { in: ids } },
        orderBy: { created_at: 'desc' },
        take: 50,
        include: { refunds: true, workspace: { select: OWNER_SELECT } },
      }),
      prisma.invoice.findMany({
        where: { workspace_id: { in: ids } },
        orderBy: { issued_at: 'desc' },
        take: 50,
        include: { workspace: { select: OWNER_SELECT } },
      }),
      prisma.creditBalance.findMany({ where: { workspace_id: { in: ids } } }),
      prisma.creditTransaction.findMany({
        where: { workspace_id: { in: ids } },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      prisma.subscriptionEvent.findMany({
        where: { workspace_id: { in: ids } },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      prisma.checkoutSession.findMany({
        where: { workspace_id: { in: ids }, status: 'open', expires_at: { gt: new Date() } },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const balance = balances.reduce((sum, b) => sum + b.balance_cents, 0);
    const admins = await adminNameMap(ledger.map((t) => t.admin_id));
    res.json({
      user,
      workspaces: owned.map((w) => ({
        ...subscriptionRow(w, names),
        card_count: cards.filter((c) => c.workspace_id === w.id).length,
      })),
      payments: payments.map(paymentRow),
      invoices: invoices.map(invoiceRow),
      // Masked metadata only. §58: "NEVER show full card number or CVV."
      payment_methods: cards.map((c) => ({ ...cardView(c), workspace_id: c.workspace_id })),
      credit: {
        balance_cents: balance,
        balance_label: formatMoney(balance),
        transactions: ledger.map((t) => ({
          id: t.id,
          workspace_id: t.workspace_id,
          amount_cents: t.amount_cents,
          amount_label: formatMoney(t.amount_cents),
          kind: t.kind,
          reason: t.reason,
          admin_id: t.admin_id,
          admin_email: t.admin_id ? admins.get(t.admin_id) ?? null : null,
          balance_after: t.balance_after,
          created_at: t.created_at,
        })),
      },
      events,
      // An open session explains "they clicked upgrade and nothing happened":
      // the plan is waiting on the provider, not on us.
      open_checkouts: checkouts.map((c) => ({
        id: c.id,
        workspace_id: c.workspace_id,
        plan_key: c.plan_key,
        amount_cents: c.amount_cents,
        amount_label: formatMoney(c.amount_cents, c.currency),
        provider: c.provider,
        status: c.status,
        created_at: c.created_at,
        expires_at: c.expires_at,
      })),
      never_stored: ['card_number', 'cvv', 'security_code'],
    });
  } catch (error) {
    console.error('[adminBilling] user billing failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the billing details.');
  }
});

// ── §44 billing analytics ────────────────────────────────────────────────────

/**
 * MRR, ARR, churn and conversion — all derived from rows, never from a constant
 * (§55: "Do not create fake dashboard statistics in production").
 *
 * Two deliberate choices:
 *  • MRR counts only accounts whose *entitlement* is live and paid for, and
 *    excludes manual overrides, because a comped Pro account produces no revenue.
 *    Comped value is reported separately rather than folded in, so the number is
 *    both honest and explainable.
 *  • Collected revenue comes from Payment rows net of refunds, not from plan
 *    prices, because a discounted or credit-funded activation charged less than
 *    list price.
 */
router.get('/billing/analytics', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const days = Math.min(365, Math.max(1, parseInt((req.query.days as string) || '30', 10) || 30));
    const since = new Date(now.getTime() - days * 86_400_000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);

    const [workspaces, monthly, succeeded, statusCounts, failedCount, pendingCount, openCheckouts, creditOut] =
      await Promise.all([
        prisma.workspace.findMany({
          select: {
            plan_key: true,
            subscription_status: true,
            current_period_end: true,
            manual_override: true,
            billing_provider: true,
            created_at: true,
          },
        }),
        monthlyPriceMap(),
        // Every settled payment in the last 13 months, for the series and the
        // period totals. Bounded by date, so this stays a small read.
        prisma.payment.findMany({
          where: {
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            succeeded_at: { gte: yearAgo },
          },
          select: {
            amount_cents: true,
            refunded_cents: true,
            currency: true,
            plan_key: true,
            succeeded_at: true,
            workspace_id: true,
          },
        }),
        prisma.payment.groupBy({
          by: ['status'],
          where: { created_at: { gte: since } },
          _count: { _all: true },
        }),
        prisma.payment.count({ where: { status: 'failed', created_at: { gte: since } } }),
        prisma.payment.count({ where: { status: { in: ['pending', 'processing'] } } }),
        prisma.checkoutSession.count({ where: { status: 'open', expires_at: { gt: now } } }),
        prisma.creditBalance.aggregate({ _sum: { balance_cents: true } }),
      ]);

    // ── recurring revenue, from live entitlements ──
    let mrr = 0;
    let compedMrr = 0;
    let payingAccounts = 0;
    let compedAccounts = 0;
    const planCounts = new Map<string, number>();
    for (const w of workspaces) {
      const effective = effectivePlanKey(w);
      planCounts.set(effective, (planCounts.get(effective) ?? 0) + 1);
      if (!isPaidPlan(effective)) continue;
      const price = monthly.get(effective) ?? 0;
      if (w.manual_override) {
        compedMrr += price;
        compedAccounts += 1;
      } else {
        mrr += price;
        payingAccounts += 1;
      }
    }

    // ── collected revenue, net of refunds ──
    const netOf = (rows: typeof succeeded) => rows.reduce((s, p) => s + p.amount_cents - p.refunded_cents, 0);
    const inRange = (from: Date) => succeeded.filter((p) => p.succeeded_at && p.succeeded_at >= from);
    const revenueToday = netOf(inRange(dayStart));
    const revenueMonth = netOf(inRange(monthStart));
    const revenueRange = netOf(inRange(since));

    // 12-month series, keyed YYYY-MM so the chart needs no date maths.
    const series: Array<{ month: string; revenue_cents: number; payments: number }> = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const rows = succeeded.filter((p) => p.succeeded_at && p.succeeded_at >= start && p.succeeded_at < end);
      series.push({
        month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        revenue_cents: netOf(rows),
        payments: rows.length,
      });
    }

    // ── churn + conversion ──
    const [churned, activatedInRange, totalAccounts] = await Promise.all([
      prisma.subscriptionEvent.count({
        where: { event: { in: ['canceled', 'expired'] }, created_at: { gte: since } },
      }),
      prisma.subscriptionEvent.count({
        where: { event: { in: ['activated', 'upgraded'] }, created_at: { gte: since } },
      }),
      prisma.user.count(),
    ]);
    // Churn over the window: cancellations ÷ the base that could have churned
    // (accounts paying now plus the ones that left). 0 when there is no base —
    // reporting 0 % on an empty denominator beats reporting NaN or 100 %.
    const churnBase = payingAccounts + churned;
    const churnRate = churnBase > 0 ? churned / churnBase : 0;
    const conversion = totalAccounts > 0 ? payingAccounts / totalAccounts : 0;

    const attempted = statusCounts.reduce((s, r) => s + r._count._all, 0);
    const settled = statusCounts
      .filter((r) => ['succeeded', 'partially_refunded', 'refunded'].includes(r.status))
      .reduce((s, r) => s + r._count._all, 0);

    // Highest-value accounts in the window, so support knows who to call first.
    const byWorkspace = new Map<string, number>();
    for (const p of inRange(since)) {
      byWorkspace.set(p.workspace_id, (byWorkspace.get(p.workspace_id) ?? 0) + p.amount_cents - p.refunded_cents);
    }
    const topIds = [...byWorkspace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topWorkspaces = await prisma.workspace.findMany({
      where: { id: { in: topIds.map(([id]) => id) } },
      select: OWNER_SELECT,
    });
    const topById = new Map(topWorkspaces.map((w) => [w.id, w]));

    const names = await planNameMap();
    res.json({
      range: { days, from: since, to: now },
      recurring: {
        mrr_cents: mrr,
        mrr_label: formatMoney(mrr),
        arr_cents: mrr * 12,
        arr_label: formatMoney(mrr * 12),
        arpa_cents: payingAccounts > 0 ? Math.round(mrr / payingAccounts) : 0,
        paying_accounts: payingAccounts,
        // Comped value is shown next to MRR, never inside it (§59).
        comped_mrr_cents: compedMrr,
        comped_mrr_label: formatMoney(compedMrr),
        comped_accounts: compedAccounts,
      },
      collected: {
        today_cents: revenueToday,
        today_label: formatMoney(revenueToday),
        month_cents: revenueMonth,
        month_label: formatMoney(revenueMonth),
        range_cents: revenueRange,
        range_label: formatMoney(revenueRange),
      },
      health: {
        churn_rate: Number(churnRate.toFixed(4)),
        churned_in_range: churned,
        activated_in_range: activatedInRange,
        conversion_rate: Number(conversion.toFixed(4)),
        total_accounts: totalAccounts,
        payment_success_rate: attempted > 0 ? Number((settled / attempted).toFixed(4)) : 0,
        payments_attempted: attempted,
        failed_payments: failedCount,
        pending_payments: pendingCount,
        open_checkouts: openCheckouts,
        credit_liability_cents: creditOut._sum.balance_cents ?? 0,
        credit_liability_label: formatMoney(creditOut._sum.balance_cents ?? 0),
      },
      revenue_by_month: series,
      plan_distribution: [...planCounts.entries()]
        .map(([key, count]) => ({
          key,
          name: names.get(key) ?? key,
          count,
          monthly_price_cents: monthly.get(key) ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
      payment_statuses: statusCounts.map((s) => ({ key: s.status, count: s._count._all })),
      top_accounts: topIds.map(([id, cents]) => ({
        revenue_cents: cents,
        revenue_label: formatMoney(cents),
        ...accountOf(topById.get(id)),
      })),
    });
  } catch (error) {
    console.error('[adminBilling] analytics failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not compute billing analytics.');
  }
});

export default router;
