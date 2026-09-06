/**
 * Payment provider webhooks — the only door to a paid plan (spec §34).
 *
 * "Never activate plans based on: Frontend success response, Button click, Query
 * parameter, Client-side state, Local storage. Only backend payment provider
 * verification can activate a subscription."
 *
 * So this router is the *sole* caller of `activateFromPayment()` on the customer
 * path, and nothing here trusts the request body until its signature has been
 * checked. Four properties are load-bearing:
 *
 *   1. RAW BYTES. Mounted with `express.raw()` before the global JSON parser,
 *      because an HMAC over a re-serialised body is an HMAC over different bytes.
 *   2. UNAUTHENTICATED BUT NOT UNPROTECTED. There is no session here — the
 *      provider is not a logged-in user. The signature *is* the authentication.
 *   3. EVERY ATTEMPT IS EVIDENCE. Accepted, ignored and rejected deliveries all
 *      land in `provider_webhook_events`. A forged event is a security finding,
 *      not something to drop silently.
 *   4. IDEMPOTENCY. `@@unique([provider, event_id])` makes the database refuse a
 *      replay, and `activateFromPayment()` short-circuits an already-succeeded
 *      payment. "If the same payment webhook arrives 5 times, it must only
 *      activate the subscription ONCE."
 *
 * Status codes matter to the sender: 2xx means "stop retrying". A bad signature
 * gets 400 (retrying will not fix it), an event we could not process yet gets 500
 * so the provider redelivers, and a duplicate gets 200.
 */
import express, { Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { clientIp, writeSystemAudit } from '../lib/audit.js';
import {
  activateFromPayment,
  cancelSubscription,
  recordFailure,
  recordRefund,
} from '../lib/billingState.js';
import {
  getBillingConfig,
  verifyAndParse,
  type ParsedEvent,
  type ProviderName,
} from '../lib/paymentProvider.js';

const router = express.Router();

/** Providers we know how to verify. The URL segment must name one of these. */
const PROVIDERS: ProviderName[] = ['stripe', 'razorpay', 'manual'];

/**
 * Bytes exactly as the provider sent them. `express.raw()` gives a Buffer; the
 * `rawBody` fallback covers a body the global JSON parser reached first.
 */
function rawBodyOf(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  const captured = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(captured)) return captured;
  return Buffer.alloc(0);
}

/** Truncate a detail string so one hostile payload cannot bloat the table. */
function detail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

/** The parsed body, stored for support and forensics. Never trusted for amounts. */
function payloadFor(raw: Buffer): unknown {
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { body: String(parsed) };
  } catch {
    return { unparseable: true, bytes: raw.length };
  }
}

/**
 * Find the payment a verified event refers to.
 *
 * Two routes in, both server-side: the provider's own payment id (which we stored on
 * the Payment row when the checkout was created) and our checkout session id (which
 * we put into the provider's metadata and it echoed back). The event body never
 * names a workspace or a plan — those come from our own row, so a forged-but-signed
 * payload still cannot buy a different plan than the one that was checked out.
 */
async function resolvePayment(parsed: ParsedEvent) {
  if (parsed.paymentRef) {
    const byRef = await prisma.payment.findUnique({ where: { provider_ref: parsed.paymentRef } });
    if (byRef) return byRef;
  }
  if (parsed.checkoutRef) {
    const session = await prisma.checkoutSession.findUnique({ where: { id: parsed.checkoutRef } });
    if (session?.payment_id) {
      const bySession = await prisma.payment.findUnique({ where: { id: session.payment_id } });
      if (bySession) {
        // First time we learn the provider's id for this charge — record it so a
        // later refund or dispute event resolves on the first lookup.
        if (!bySession.provider_ref && parsed.paymentRef) {
          await prisma.payment
            .update({ where: { id: bySession.id }, data: { provider_ref: parsed.paymentRef } })
            .catch(() => {});
        }
        return bySession;
      }
    }
  }
  return null;
}

interface Outcome {
  /** Row status: what we did with this delivery. */
  status: 'processed' | 'ignored' | 'failed';
  detail: string | null;
  /** What the provider is told. 2xx = stop retrying. */
  httpStatus: number;
}

/**
 * Act on a verified event.
 *
 * A refusal here is *terminal* — answered 2xx — whenever redelivering the same bytes
 * would be refused again (amount drift, unknown payment, an event type we do not
 * act on). Only an unexpected throw escapes to the caller and becomes a 500, which
 * is the one case where a retry can help.
 */
async function dispatch(
  provider: ProviderName,
  parsed: ParsedEvent,
  ip: string | null,
): Promise<Outcome> {
  if (parsed.kind === 'ignored') {
    return { status: 'ignored', detail: `no action for ${parsed.eventType}`, httpStatus: 200 };
  }

  if (parsed.kind === 'subscription_canceled') {
    // Cancellation events carry a subscription id, not a payment id.
    const ref = parsed.paymentRef;
    const workspace = ref
      ? await prisma.workspace.findFirst({ where: { subscription_id: ref } })
      : null;
    if (!workspace) {
      return {
        status: 'ignored',
        detail: `no workspace for subscription ${ref ?? '(none)'}`,
        httpStatus: 200,
      };
    }
    // At period end, not immediately: the customer paid for the month they are in.
    const result = await cancelSubscription({
      workspace_id: workspace.id,
      at_period_end: true,
      reason: `${provider} webhook: ${parsed.eventType}`,
      source: 'webhook',
    });
    return result.ok
      ? { status: 'processed', detail: null, httpStatus: 200 }
      : { status: 'failed', detail: detail(result.detail), httpStatus: 200 };
  }

  const payment = await resolvePayment(parsed);
  if (!payment) {
    // Signed, so it really came from the provider — but it points at nothing we
    // created. Recorded and dropped rather than retried forever.
    return {
      status: 'ignored',
      detail: `no matching payment (ref=${parsed.paymentRef ?? '-'}, checkout=${parsed.checkoutRef ?? '-'})`,
      httpStatus: 200,
    };
  }

  if (parsed.kind === 'payment_failed') {
    const result = await recordFailure({
      payment_id: payment.id,
      code: parsed.failureCode ?? 'provider_declined',
      message: parsed.failureMessage ?? 'Payment failed at the provider.',
      provider_event: { event_id: parsed.eventId, event_type: parsed.eventType },
    });
    // §35: the plan does not change. The customer keeps what they had and can retry.
    return result.ok
      ? { status: 'processed', detail: null, httpStatus: 200 }
      : { status: 'failed', detail: detail(result.detail), httpStatus: 200 };
  }

  if (parsed.kind === 'refund') {
    const amount = parsed.refundedCents ?? payment.amount_cents;
    const already = payment.refunded_cents;
    // Providers report the *cumulative* refunded total; we store movements.
    const delta = amount - already;
    if (delta <= 0) {
      return { status: 'ignored', detail: 'refund already recorded', httpStatus: 200 };
    }
    const result = await recordRefund({
      payment_id: payment.id,
      amount_cents: delta,
      reason: `${provider} webhook: ${parsed.eventType}`,
      provider,
      provider_ref: parsed.paymentRef,
      // Whether service is revoked is an operator decision, never an automatic
      // consequence of a refund arriving.
      revoke_plan: false,
    });
    return result.ok
      ? { status: 'processed', detail: null, httpStatus: 200 }
      : { status: 'failed', detail: detail(result.detail), httpStatus: 200 };
  }

  // ── payment_succeeded: the one path that grants a plan ──────────────────
  const result = await activateFromPayment({
    payment_id: payment.id,
    source: 'webhook',
    // Checked against the amount and currency *we* recorded at checkout. A payload
    // claiming $1 for a $99 plan is refused here.
    observed_amount_cents: parsed.amountCents,
    observed_currency: parsed.currency,
    provider_ref: parsed.paymentRef,
    provider_event: { event_id: parsed.eventId, event_type: parsed.eventType },
    period_start: parsed.periodStart ?? null,
    period_end: parsed.periodEnd ?? null,
  });

  if (result.ok) {
    if (parsed.checkoutRef) {
      await prisma.checkoutSession
        .updateMany({
          where: { id: parsed.checkoutRef, status: 'open' },
          data: { status: 'completed', completed_at: new Date() },
        })
        .catch(() => {});
    }
    return {
      status: 'processed',
      detail: result.duplicate ? 'duplicate delivery; already active' : null,
      httpStatus: 200,
    };
  }

  // A signed event that fails validation is the shape a tampered payload has, so it
  // is escalated rather than just logged.
  await writeSystemAudit('billing.webhook.rejected', {
    target_type: 'payment',
    target_id: payment.id,
    severity: 'critical',
    ip,
    reason: result.detail ?? 'activation refused',
    metadata: {
      provider,
      event_id: parsed.eventId,
      event_type: parsed.eventType,
      observed_amount_cents: parsed.amountCents,
      observed_currency: parsed.currency,
      expected_amount_cents: payment.amount_cents,
      expected_currency: payment.currency,
    },
  });
  return { status: 'failed', detail: detail(result.detail), httpStatus: 200 };
}

/**
 * POST /api/billing/webhooks/:provider
 *
 * Order is deliberate: verify, then claim the idempotency slot, then act. Claiming
 * before verifying would let anyone burn a real event id by POSTing garbage with
 * that id in it — the genuine delivery would afterwards look like a replay and be
 * skipped. Rejected attempts are therefore stored under a `rejected:` key, which
 * cannot collide with a provider's own id.
 */
router.post('/:provider', async (req: Request, res: Response) => {
  const name = String(req.params.provider || '').toLowerCase();
  const ip = clientIp(req);

  if (!PROVIDERS.includes(name as ProviderName)) {
    res.status(404).json({ success: false, error: { code: 'UNKNOWN_PROVIDER' } });
    return;
  }
  const provider = name as ProviderName;
  const raw = rawBodyOf(req);
  if (raw.length === 0) {
    res.status(400).json({ success: false, error: { code: 'EMPTY_BODY' } });
    return;
  }

  try {
    const cfg = await getBillingConfig();
    const { verify, parsed } = verifyAndParse(provider, raw, req.headers, cfg);

    if (!verify.ok) {
      await prisma.providerWebhookEvent
        .upsert({
          where: { provider_event_id: { provider, event_id: `rejected:${parsed.eventId}` } },
          create: {
            provider,
            event_id: `rejected:${parsed.eventId}`,
            event_type: parsed.eventType,
            status: 'rejected',
            detail: detail(verify.detail ?? 'signature verification failed'),
            signature_ok: false,
            payload: payloadFor(raw) as never,
            ip,
          },
          update: {
            detail: detail(verify.detail ?? 'signature verification failed'),
            received_at: new Date(),
          },
        })
        .catch(() => {});

      await writeSystemAudit('billing.webhook.unsigned', {
        target_type: 'webhook',
        target_id: parsed.eventId,
        severity: 'critical',
        ip,
        reason: verify.detail ?? 'signature verification failed',
        metadata: { provider, event_type: parsed.eventType },
      });
      // 400, not 401: there is no credential to re-present, and a retry of the same
      // bytes would fail identically.
      res.status(400).json({ success: false, error: { code: 'BAD_SIGNATURE' } });
      return;
    }

    // Claim the slot. The unique index — not a read-then-write check — is what makes
    // concurrent duplicate deliveries safe.
    let event;
    try {
      event = await prisma.providerWebhookEvent.create({
        data: {
          provider,
          event_id: parsed.eventId,
          event_type: parsed.eventType,
          status: 'received',
          signature_ok: true,
          payload: payloadFor(raw) as never,
          ip,
        },
      });
    } catch {
      const existing = await prisma.providerWebhookEvent.findUnique({
        where: { provider_event_id: { provider, event_id: parsed.eventId } },
      });
      if (existing && (existing.status === 'processed' || existing.status === 'ignored')) {
        // The §34 acceptance test: the fifth delivery of one charge changes nothing.
        res.status(200).json({ success: true, duplicate: true, status: existing.status });
        return;
      }
      // A previous attempt was recorded but never finished (crash, transient error).
      // Re-run it: every handler downstream is idempotent.
      event = existing ?? null;
    }

    const outcome = await dispatch(provider, parsed, ip);

    if (event) {
      await prisma.providerWebhookEvent
        .update({
          where: { id: event.id },
          data: {
            status: outcome.status,
            detail: outcome.detail,
            processed_at: new Date(),
          },
        })
        .catch(() => {});
    }

    res.status(outcome.httpStatus).json({
      success: outcome.status !== 'failed',
      status: outcome.status,
      detail: outcome.detail ?? undefined,
    });
  } catch (err) {
    console.error(`[webhook:${provider}] processing failed:`, err);
    // 500 so the provider redelivers — this is the transient-failure case.
    res.status(500).json({ success: false, error: { code: 'WEBHOOK_ERROR' } });
  }
});

/**
 * GET /api/billing/webhooks/:provider — a reachability probe.
 *
 * Providers and operators both hit the URL in a browser to check it exists. Saying
 * so plainly beats a 404 that looks like a misconfiguration, and it reveals nothing:
 * no secret, no state, no event data.
 */
router.get('/:provider', (req: Request, res: Response) => {
  const name = String(req.params.provider || '').toLowerCase();
  if (!PROVIDERS.includes(name as ProviderName)) {
    res.status(404).json({ success: false, error: { code: 'UNKNOWN_PROVIDER' } });
    return;
  }
  res.json({
    ok: true,
    provider: name,
    method: 'POST',
    message: 'Send signed webhook events here with POST.',
  });
});

export default router;
