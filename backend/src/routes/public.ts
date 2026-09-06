/**
 * The marketing homepage's data source.
 *
 * `godhosting.cyou/` used to bounce a first-time visitor straight into
 * `/sign-in`, so the product had no front door: nothing said what it does, what
 * it costs, or whether signups are even open. The homepage that replaces that
 * redirect is a real page, and this is the only endpoint it needs.
 *
 * Everything here is read from the database, not written into the page:
 *
 *  • `plans` is the same `planCatalog()` the billing page and checkout use, so
 *    editing a price in Admin → Plans changes the homepage. No invented numbers
 *    (§53) and no second copy of the pricing table to drift out of sync.
 *  • `features` is the live feature-flag map, so the homepage never advertises a
 *    capability the operator has switched off.
 *  • `registration_enabled` / `setup_complete` decide which call to action the
 *    page shows — pointing a visitor at a signup form that will reject them is
 *    exactly the kind of dead button the brief rules out.
 *
 * Unauthenticated by design, and deliberately narrow because of it: no counts,
 * no user data, no infrastructure detail. A visitor learns what the platform
 * offers and nothing about who is already on it.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import prisma from '../lib/prisma.js';
import { getBoolSetting, getSetting } from '../lib/settings.js';
import { getFeatureFlags } from '../lib/featureFlags.js';
import { planCatalog } from '../lib/planCatalog.js';

const router = Router();

/**
 * The one unauthenticated read surface in the app, so it carries its own ceiling.
 * `apiLimiter` skips GETs (the dashboard polls constantly) and this mounts ahead
 * of it anyway; without a limiter here the homepage would be a free way to make
 * the server hit its database. Keyed by IP because there is no user to key by.
 */
const landingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  message: { error: 'Too many requests, please slow down and try again shortly.' },
});

/** Only the fields a price card renders — limits and features, never internals. */
function publicPlan(plan: Awaited<ReturnType<typeof planCatalog>>[number]) {
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description,
    price_cents: plan.price_cents,
    price_yearly_cents: plan.price_yearly_cents,
    currency: plan.currency,
    interval: plan.interval,
    highlighted: plan.highlighted,
    trial_days: plan.trial_days,
    benefits: plan.benefits,
    limits: plan.limits,
  };
}

/**
 * GET /api/public/landing — everything the homepage renders.
 *
 * Degrades instead of failing: on a brand-new install whose migrations or seed
 * have not run, the catalogue falls back to the shipped tiers and the page still
 * renders. A homepage that 500s because a settings row is missing would be the
 * first thing a visitor sees.
 */
router.get('/landing', landingLimiter, async (_req: Request, res: Response) => {
  const [name, registration, flags, plans, userCount] = await Promise.all([
    getSetting('platform_name').catch(() => null),
    getBoolSetting('registration_enabled', true).catch(() => true),
    getFeatureFlags().catch(() => ({}) as Record<string, boolean>),
    planCatalog().catch(() => []),
    // Only ever compared against zero, and only to choose between "Create
    // account" and "Claim this server" — the number itself is not returned.
    prisma.user.count().catch(() => 1),
  ]);

  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    platform_name: name || 'God Hosting',
    registration_enabled: registration,
    setup_complete: userCount > 0,
    features: flags,
    plans: plans.map(publicPlan),
  });
});

export default router;
