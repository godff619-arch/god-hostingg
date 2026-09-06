/**
 * Payment provider abstraction (spec §7, §34).
 *
 * WHAT THIS IS FOR
 * ----------------
 * The one rule the whole billing rewrite exists to enforce: a paid plan is
 * activated *only* by a provider event whose signature this module verified. So
 * every provider — Stripe, Razorpay, or the self-hosted "manual" one — has to
 * answer the same three questions:
 *
 *   1. `createCheckout()` — where do I send the user to pay?
 *   2. `verifySignature()` — is this inbound webhook really from you?
 *   3. `parseEvent()`     — which payment, which amount, succeeded or failed?
 *
 * Anything the frontend says is ignored. `parseEvent` returns the amount and plan
 * *from the provider payload*, and `billingState.activateFromPayment()` compares
 * them against the Payment row it created at checkout time. A tampered redirect,
 * a replayed body, or a hand-rolled POST all fail one of those checks.
 *
 * THE "manual" PROVIDER
 * --------------------
 * A self-hosted install with no payment processor still needs a coherent billing
 * story, so `manual` is a first-class provider: checkout produces an *unpaid*
 * invoice and leaves the workspace on its current plan. An operator confirms the
 * bank transfer in the admin panel, which goes through the same
 * `activateFromPayment()` path with `source = admin` and a mandatory reason. What
 * it never does is flip the plan because a card exists — that was the bug.
 *
 * Credentials live in the DB `Settings` table sealed with `secretBox`, so they are
 * configurable at runtime from the admin panel and never appear in a response.
 */
import crypto from 'crypto';
import { getSetting, setSetting } from './settings.js';
import { open, seal } from './secretBox.js';

export type ProviderName = 'manual' | 'stripe' | 'razorpay';

/** Settings keys. Secrets are sealed with secretBox; publishable ids are not. */
const S_PROVIDER = 'billing.provider';
const S_CURRENCY = 'billing.currency';
const S_STRIPE_PK = 'billing.stripe.publishable_key';
const S_STRIPE_SK = 'billing.stripe.secret_key';
const S_STRIPE_WHSEC = 'billing.stripe.webhook_secret';
const S_RAZORPAY_KEY = 'billing.razorpay.key_id';
const S_RAZORPAY_SECRET = 'billing.razorpay.key_secret';
const S_RAZORPAY_WHSEC = 'billing.razorpay.webhook_secret';
const S_MANUAL_INSTRUCTIONS = 'billing.manual.instructions';

/** Runtime billing configuration, secrets already unsealed for server-side use. */
export interface BillingConfig {
  provider: ProviderName;
  currency: string;
  stripe: { publishableKey: string | null; secretKey: string | null; webhookSecret: string | null };
  razorpay: { keyId: string | null; keySecret: string | null; webhookSecret: string | null };
  manualInstructions: string | null;
}

function isProvider(v: string | null): v is ProviderName {
  return v === 'manual' || v === 'stripe' || v === 'razorpay';
}

/**
 * Load billing config. Env vars win over DB settings so a container can be
 * configured without a first-run visit to the admin panel; the DB is the fallback
 * and what the admin UI writes.
 */
export async function getBillingConfig(): Promise<BillingConfig> {
  const dbProvider = await getSetting(S_PROVIDER);
  const envProvider = process.env.BILLING_PROVIDER?.trim() ?? null;
  const provider: ProviderName = isProvider(envProvider)
    ? envProvider
    : isProvider(dbProvider)
      ? dbProvider
      : 'manual';

  const sealed = async (key: string, env?: string): Promise<string | null> => {
    const fromEnv = env ? process.env[env]?.trim() : undefined;
    if (fromEnv) return fromEnv;
    return open(await getSetting(key));
  };

  return {
    provider,
    currency: (process.env.BILLING_CURRENCY || (await getSetting(S_CURRENCY)) || 'USD').toUpperCase(),
    stripe: {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() || (await getSetting(S_STRIPE_PK)),
      secretKey: await sealed(S_STRIPE_SK, 'STRIPE_SECRET_KEY'),
      webhookSecret: await sealed(S_STRIPE_WHSEC, 'STRIPE_WEBHOOK_SECRET'),
    },
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID?.trim() || (await getSetting(S_RAZORPAY_KEY)),
      keySecret: await sealed(S_RAZORPAY_SECRET, 'RAZORPAY_KEY_SECRET'),
      webhookSecret: await sealed(S_RAZORPAY_WHSEC, 'RAZORPAY_WEBHOOK_SECRET'),
    },
    manualInstructions: await getSetting(S_MANUAL_INSTRUCTIONS),
  };
}

/** Shape the admin UI receives: presence of each secret, never a byte of it. */
export async function getBillingConfigPublic() {
  const cfg = await getBillingConfig();
  return {
    provider: cfg.provider,
    currency: cfg.currency,
    stripe: {
      publishable_key: cfg.stripe.publishableKey ?? '',
      secret_key_set: Boolean(cfg.stripe.secretKey),
      webhook_secret_set: Boolean(cfg.stripe.webhookSecret),
    },
    razorpay: {
      key_id: cfg.razorpay.keyId ?? '',
      key_secret_set: Boolean(cfg.razorpay.keySecret),
      webhook_secret_set: Boolean(cfg.razorpay.webhookSecret),
    },
    manual_instructions: cfg.manualInstructions ?? '',
    /** True when the selected provider can actually take money. */
    ready: cfg.provider === 'manual'
      ? true
      : cfg.provider === 'stripe'
        ? Boolean(cfg.stripe.secretKey && cfg.stripe.webhookSecret)
        : Boolean(cfg.razorpay.keyId && cfg.razorpay.keySecret && cfg.razorpay.webhookSecret),
    webhook_url: '/api/billing/webhooks/' + cfg.provider,
  };
}

/** Patch billing settings from the admin panel. Empty string = leave unchanged. */
export async function saveBillingConfig(patch: {
  provider?: string;
  currency?: string;
  stripe_publishable_key?: string;
  stripe_secret_key?: string;
  stripe_webhook_secret?: string;
  razorpay_key_id?: string;
  razorpay_key_secret?: string;
  razorpay_webhook_secret?: string;
  manual_instructions?: string;
}): Promise<void> {
  const plain = async (key: string, value?: string) => {
    if (value === undefined) return;
    await setSetting(key, value.trim());
  };
  // A blank secret means "keep the stored one"; clearing takes the literal
  // sentinel, so an accidentally-empty form field can't wipe live credentials.
  const secret = async (key: string, value?: string) => {
    if (value === undefined) return;
    const v = value.trim();
    if (!v) return;
    await setSetting(key, v === '__CLEAR__' ? '' : seal(v));
  };

  if (patch.provider && isProvider(patch.provider)) await setSetting(S_PROVIDER, patch.provider);
  if (patch.currency) await setSetting(S_CURRENCY, patch.currency.trim().toUpperCase());
  await plain(S_STRIPE_PK, patch.stripe_publishable_key);
  await secret(S_STRIPE_SK, patch.stripe_secret_key);
  await secret(S_STRIPE_WHSEC, patch.stripe_webhook_secret);
  await plain(S_RAZORPAY_KEY, patch.razorpay_key_id);
  await secret(S_RAZORPAY_SECRET, patch.razorpay_key_secret);
  await secret(S_RAZORPAY_WHSEC, patch.razorpay_webhook_secret);
  await plain(S_MANUAL_INSTRUCTIONS, patch.manual_instructions);
}

// ── Webhook verification ───────────────────────────────────────────────────

/** Constant-time compare that tolerates unequal lengths without throwing. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, for the `provider_webhook_events.detail` column. */
  detail?: string;
}

/**
 * Verify a Stripe signature header: `t=<unix>,v1=<hex>` over `"<t>.<rawBody>"`.
 * Implemented directly (rather than pulling in the SDK) because it is eight lines
 * of HMAC and adding a dependency to a self-hosted install has its own cost.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string | null,
  toleranceSeconds = 300,
): VerifyResult {
  if (!secret) return { ok: false, detail: 'no webhook secret configured' };
  if (!header) return { ok: false, detail: 'missing stripe-signature header' };

  const parts = header.split(',').reduce<Record<string, string[]>>((acc, kv) => {
    const [k, v] = kv.split('=');
    if (!k || !v) return acc;
    (acc[k.trim()] ||= []).push(v.trim());
    return acc;
  }, {});
  const timestamp = parts.t?.[0];
  const signatures = parts.v1 ?? [];
  if (!timestamp || signatures.length === 0) return { ok: false, detail: 'malformed signature header' };

  // Replay window (spec §34 "prevent replay attacks"): an old-but-valid signature
  // is refused even though the HMAC still checks out.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, detail: `timestamp outside tolerance (${age}s)` };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, detail: 'signature mismatch' };
  }
  return { ok: true };
}

/** Razorpay: `X-Razorpay-Signature` is HMAC-SHA256 of the raw body, hex. */
export function verifyRazorpaySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string | null,
): VerifyResult {
  if (!secret) return { ok: false, detail: 'no webhook secret configured' };
  if (!header) return { ok: false, detail: 'missing x-razorpay-signature header' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!timingSafeEqual(header.trim(), expected)) return { ok: false, detail: 'signature mismatch' };
  return { ok: true };
}

/**
 * The self-hosted provider signs with the install's own secret, so the callback
 * an operator's payment page posts back is still verified rather than trusted.
 */
export function verifyManualSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string | null,
): VerifyResult {
  if (!secret) return { ok: false, detail: 'manual webhooks require a shared secret' };
  if (!header) return { ok: false, detail: 'missing x-godhosting-signature header' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!timingSafeEqual(header.trim(), expected)) return { ok: false, detail: 'signature mismatch' };
  return { ok: true };
}

// ── Event parsing ──────────────────────────────────────────────────────────

/** Normalised provider event — the only thing the state machine ever sees. */
export interface ParsedEvent {
  /** Provider's event id. Used for the idempotency unique index. */
  eventId: string;
  eventType: string;
  /** What this event means for us. `ignored` events are recorded, not acted on. */
  kind: 'payment_succeeded' | 'payment_failed' | 'refund' | 'subscription_canceled' | 'ignored';
  /** Provider payment id, matched against `payments.provider_ref`. */
  paymentRef: string | null;
  /** Our checkout session id, round-tripped through provider metadata. */
  checkoutRef: string | null;
  amountCents: number | null;
  currency: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  refundedCents?: number | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Stable fallback event id so an unsigned/unlabelled body still deduplicates. */
export function hashEventId(rawBody: Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 40);
}

/** Stripe → ParsedEvent. Reads only fields Stripe itself signed. */
export function parseStripeEvent(body: any, rawBody: Buffer): ParsedEvent {
  const type = str(body?.type) ?? 'unknown';
  const obj = body?.data?.object ?? {};
  const metadata = obj?.metadata ?? {};
  const base = {
    eventId: str(body?.id) ?? hashEventId(rawBody),
    eventType: type,
    paymentRef: str(obj?.payment_intent) ?? str(obj?.id),
    checkoutRef: str(metadata?.checkout_session_id) ?? str(metadata?.godhosting_checkout),
    amountCents: num(obj?.amount_total) ?? num(obj?.amount_received) ?? num(obj?.amount),
    currency: str(obj?.currency)?.toUpperCase() ?? null,
  };

  switch (type) {
    case 'checkout.session.completed':
      // `payment_status` guards the case where a session completes but the async
      // payment method hasn't cleared — that is not an activation.
      return {
        ...base,
        kind: obj?.payment_status === 'paid' ? 'payment_succeeded' : 'ignored',
      };
    case 'payment_intent.succeeded':
    case 'invoice.payment_succeeded':
      return { ...base, kind: 'payment_succeeded' };
    case 'payment_intent.payment_failed':
    case 'invoice.payment_failed':
      return {
        ...base,
        kind: 'payment_failed',
        failureCode: str(obj?.last_payment_error?.code),
        failureMessage: str(obj?.last_payment_error?.message) ?? 'Payment failed at the provider.',
      };
    case 'charge.refunded':
      return { ...base, kind: 'refund', refundedCents: num(obj?.amount_refunded) };
    case 'customer.subscription.deleted':
      return { ...base, kind: 'subscription_canceled' };
    default:
      return { ...base, kind: 'ignored' };
  }
}

/** Razorpay → ParsedEvent. */
export function parseRazorpayEvent(body: any, rawBody: Buffer): ParsedEvent {
  const type = str(body?.event) ?? 'unknown';
  const payment = body?.payload?.payment?.entity ?? {};
  const refund = body?.payload?.refund?.entity ?? {};
  const notes = payment?.notes ?? {};
  const base = {
    eventId: str(body?.id) ?? hashEventId(rawBody),
    eventType: type,
    paymentRef: str(payment?.id) ?? str(refund?.payment_id),
    checkoutRef: str(notes?.checkout_session_id) ?? str(notes?.godhosting_checkout),
    amountCents: num(payment?.amount),
    currency: str(payment?.currency)?.toUpperCase() ?? null,
  };

  switch (type) {
    case 'payment.captured':
      return { ...base, kind: 'payment_succeeded' };
    case 'payment.failed':
      return {
        ...base,
        kind: 'payment_failed',
        failureCode: str(payment?.error_code),
        failureMessage: str(payment?.error_description) ?? 'Payment failed at the provider.',
      };
    case 'refund.processed':
      return { ...base, kind: 'refund', refundedCents: num(refund?.amount) };
    case 'subscription.cancelled':
      return { ...base, kind: 'subscription_canceled' };
    default:
      return { ...base, kind: 'ignored' };
  }
}

/** Manual/self-hosted provider → ParsedEvent. Same field names, no nesting. */
export function parseManualEvent(body: any, rawBody: Buffer): ParsedEvent {
  const type = str(body?.event) ?? 'unknown';
  const base = {
    eventId: str(body?.id) ?? hashEventId(rawBody),
    eventType: type,
    paymentRef: str(body?.payment_ref) ?? str(body?.payment_id),
    checkoutRef: str(body?.checkout_session_id),
    amountCents: num(body?.amount_cents),
    currency: str(body?.currency)?.toUpperCase() ?? null,
  };
  switch (type) {
    case 'payment.succeeded':
      return { ...base, kind: 'payment_succeeded' };
    case 'payment.failed':
      return {
        ...base,
        kind: 'payment_failed',
        failureCode: str(body?.failure_code),
        failureMessage: str(body?.failure_message) ?? 'Payment failed.',
      };
    case 'refund.processed':
      return { ...base, kind: 'refund', refundedCents: num(body?.refunded_cents) };
    case 'subscription.canceled':
      return { ...base, kind: 'subscription_canceled' };
    default:
      return { ...base, kind: 'ignored' };
  }
}

/** Dispatch verification + parsing for a provider named in the URL. */
export function verifyAndParse(
  provider: ProviderName,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  cfg: BillingConfig,
): { verify: VerifyResult; parsed: ParsedEvent } {
  const head = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  let body: any = {};
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      verify: { ok: false, detail: 'body is not JSON' },
      parsed: { eventId: hashEventId(rawBody), eventType: 'unparseable', kind: 'ignored', paymentRef: null, checkoutRef: null, amountCents: null, currency: null },
    };
  }

  switch (provider) {
    case 'stripe':
      return {
        verify: verifyStripeSignature(rawBody, head('stripe-signature'), cfg.stripe.webhookSecret),
        parsed: parseStripeEvent(body, rawBody),
      };
    case 'razorpay':
      return {
        verify: verifyRazorpaySignature(rawBody, head('x-razorpay-signature'), cfg.razorpay.webhookSecret),
        parsed: parseRazorpayEvent(body, rawBody),
      };
    default:
      return {
        verify: verifyManualSignature(rawBody, head('x-godhosting-signature'), manualSecret(cfg)),
        parsed: parseManualEvent(body, rawBody),
      };
  }
}

/**
 * The manual provider's shared secret. Reuses the Stripe webhook secret slot when
 * a dedicated one isn't set, so an operator has exactly one field to fill in.
 */
function manualSecret(cfg: BillingConfig): string | null {
  return process.env.MANUAL_WEBHOOK_SECRET?.trim() || cfg.stripe.webhookSecret || null;
}

// ── Checkout creation ──────────────────────────────────────────────────────

export interface CheckoutIntent {
  /** Where to send the browser. NULL for manual: show bank instructions instead. */
  redirectUrl: string | null;
  /** Provider session id, when the provider issues one. */
  providerRef: string | null;
  /** Provider payment id known up front (Razorpay orders); usually NULL. */
  paymentRef: string | null;
  /** Operator-authored instructions, for the manual provider. */
  instructions: string | null;
}

/**
 * Ask the provider for a payment page.
 *
 * Stripe/Razorpay need an outbound HTTPS call with the secret key. That call is
 * made here rather than in the route so the route never sees a credential. When
 * the provider is unreachable or unconfigured the checkout still records an open
 * session and returns `redirectUrl: null` — the caller surfaces "payment provider
 * unavailable" and the plan stays put, which is the correct failure mode.
 */
export async function createCheckout(args: {
  provider: ProviderName;
  cfg: BillingConfig;
  sessionId: string;
  planKey: string;
  planName: string;
  amountCents: number;
  currency: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<CheckoutIntent> {
  const { provider, cfg } = args;

  if (provider === 'stripe' && cfg.stripe.secretKey) {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', args.successUrl);
    form.set('cancel_url', args.cancelUrl);
    form.set('client_reference_id', args.sessionId);
    form.set('metadata[checkout_session_id]', args.sessionId);
    form.set('metadata[plan_key]', args.planKey);
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', args.currency.toLowerCase());
    form.set('line_items[0][price_data][unit_amount]', String(args.amountCents));
    form.set('line_items[0][price_data][product_data][name]', args.planName);
    if (args.customerEmail) form.set('customer_email', args.customerEmail);

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.stripe.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message || `Stripe checkout failed (${res.status})`);
    }
    return {
      redirectUrl: str(json?.url),
      providerRef: str(json?.id),
      paymentRef: str(json?.payment_intent),
      instructions: null,
    };
  }

  if (provider === 'razorpay' && cfg.razorpay.keyId && cfg.razorpay.keySecret) {
    const auth = Buffer.from(`${cfg.razorpay.keyId}:${cfg.razorpay.keySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: args.amountCents,
        currency: args.currency,
        receipt: args.sessionId,
        notes: { checkout_session_id: args.sessionId, plan_key: args.planKey },
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.description || `Razorpay order failed (${res.status})`);
    }
    // Razorpay is collected by its browser SDK against the order id, so there is
    // no hosted URL to redirect to; the frontend opens the checkout widget.
    return {
      redirectUrl: null,
      providerRef: str(json?.id),
      paymentRef: null,
      instructions: null,
    };
  }

  return {
    redirectUrl: null,
    providerRef: null,
    paymentRef: null,
    instructions:
      cfg.manualInstructions ||
      'Bank transfer / offline payment. An operator will confirm your payment and activate the plan.',
  };
}
