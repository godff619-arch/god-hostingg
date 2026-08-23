// Workspace billing API. Every figure is derived from real rows:
//   - included-usage numerators come from UsageRecord
//   - the allowance denominators come from INCLUDED_USAGE (plan config)
//   - unbilled charges are summed from rate_micros on the same records
// Nothing is hardcoded per-account; an empty month legitimately reads 0.
//
// Money is integer cents (rates are integer micro-cents) — no float currency.

import express, { Response } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import prisma from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import {
  INCLUDED_USAGE,
  currentPeriod,
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

const PLAN_CATALOG: Array<{
  key: PlanTier;
  name: string;
  price_cents: number;
  blurb: string;
  benefits: string[];
}> = [
  {
    key: 'hobby',
    name: 'Hobby',
    price_cents: 0,
    blurb: 'For side projects and experiments.',
    benefits: [
      '750 free instance hours per month',
      '1 custom domain',
      '100 GB bandwidth',
      'Community support',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price_cents: 1900,
    blurb: 'For production workloads and small teams.',
    benefits: [
      '1,000 instance hours per month',
      '25 custom domains',
      '500 GB bandwidth',
      'Webhooks, dedicated IPs and audit logs',
      'Email support',
    ],
  },
  {
    key: 'scale',
    name: 'Scale',
    price_cents: 9900,
    blurb: 'For teams with compliance and SSO requirements.',
    benefits: [
      'Unlimited instance hours',
      'Unlimited custom domains',
      '1 TB bandwidth',
      'SAML SSO and SCIM provisioning',
      'HIPAA compliance',
      'Priority support',
    ],
  },
];

// GET /api/billing — the whole billing page in one round trip.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = normalizeTier(workspace.plan_key);
    const period = currentPeriod();
    const included = INCLUDED_USAGE[tier];

    const [records, methods, profile, credit, invoices, domainCount, serviceCount] =
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
      plans: PLAN_CATALOG,
      payment_methods: methods.map((m) => ({
        id: m.id,
        brand: m.brand,
        last4: m.last4,
        exp_month: m.exp_month,
        exp_year: m.exp_year,
        is_default: m.is_default,
      })),
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
        period_start: inv.period_start,
        period_end: inv.period_end,
        amount_cents: inv.amount_cents,
        currency: inv.currency,
        status: inv.status,
        has_pdf: !!inv.pdf_path,
        issued_at: inv.issued_at,
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

// PATCH /api/billing/plan — change the workspace plan.
router.patch('/plan', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const key = String(req.body?.plan_key || '').toLowerCase();
    if (!PLAN_CATALOG.some((p) => p.key === key)) {
      return fail(res, 400, 'INVALID_PLAN', 'Unknown plan.');
    }
    if (key === workspace.plan_key) {
      return fail(res, 409, 'SAME_PLAN', `You are already on ${tierLabel(key as PlanTier)}.`);
    }

    const paid = key !== 'hobby';
    if (paid) {
      const hasCard = await prisma.paymentMethod.count({ where: { workspace_id: workspace.id } });
      if (hasCard === 0) {
        return fail(res, 409, 'NO_PAYMENT_METHOD', 'Add a payment method before upgrading.');
      }
    }

    const updated = await prisma.workspace.update({
      where: { id: workspace.id },
      data: { plan_key: key },
    });
    await writeAudit(req, 'billing.plan.change', `workspace:${workspace.id}`, {
      from: workspace.plan_key,
      to: key,
    });
    res.json({
      success: true,
      plan: { key: updated.plan_key, label: tierLabel(normalizeTier(updated.plan_key)) },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] plan change failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not change the plan.');
  }
});

// POST /api/billing/payment-methods — store provider metadata only, never a PAN.
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
    // Defence in depth: refuse anything that looks like a full card number.
    if (/\d{12,}/.test(JSON.stringify(req.body))) {
      return fail(res, 400, 'RAW_CARD', 'Card numbers must be tokenized by the payment provider.');
    }

    const existing = await prisma.paymentMethod.count({ where: { workspace_id: workspace.id } });
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
      },
    });
    await writeAudit(req, 'billing.card.add', `payment_method:${method.id}`, {
      brand,
      last4,
    });
    res.status(201).json({
      success: true,
      payment_method: {
        id: method.id,
        brand: method.brand,
        last4: method.last4,
        exp_month: method.exp_month,
        exp_year: method.exp_year,
        is_default: method.is_default,
      },
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
    if (remaining === 0 && normalizeTier(workspace.plan_key) !== 'hobby') {
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

// POST /api/billing/promo — redeem a promo code into the credit balance.
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
    if (!promo) return fail(res, 404, 'INVALID_CODE', 'That promo code is not valid.');
    if (promo.expires_at && promo.expires_at.getTime() < Date.now()) {
      return fail(res, 409, 'EXPIRED', 'That promo code has expired.');
    }
    if (promo.redemptions.some((r) => r.workspace_id === workspace.id)) {
      return fail(res, 409, 'ALREADY_REDEEMED', 'This code has already been redeemed.');
    }
    if (promo.max_redemables !== null && promo.redemptions.length >= promo.max_redemables) {
      return fail(res, 409, 'FULLY_REDEEMED', 'That promo code is no longer available.');
    }

    const [, credit] = await prisma.$transaction([
      prisma.promoRedemption.create({
        data: { promo_code_id: promo.id, workspace_id: workspace.id },
      }),
      prisma.creditBalance.upsert({
        where: { workspace_id: workspace.id },
        update: { balance_cents: { increment: promo.amount_cents } },
        create: { workspace_id: workspace.id, balance_cents: promo.amount_cents },
      }),
    ]);

    await writeAudit(req, 'billing.promo.redeem', `workspace:${workspace.id}`, { code });
    res.json({
      success: true,
      added_cents: promo.amount_cents,
      balance_cents: credit.balance_cents,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[billing] promo failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not redeem the code.');
  }
});

export default router;
