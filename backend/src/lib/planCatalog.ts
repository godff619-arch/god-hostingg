/**
 * The billed plan catalogue — DB-backed, with the shipped tiers as a fallback.
 *
 * §9 wants the plans to be editable from the admin panel, and §53 wants no fake
 * numbers, so the pricing page reads `Plan` rows rather than a constant. Only the
 * three billed keys (`hobby | pro | scale`) belong to the customer-facing catalogue;
 * the legacy `free | premium | admin` rows stay out of it (they exist for
 * `User.plan_id` quota lookups — see scripts/seedPlans.ts).
 *
 * `FALLBACK` is not decoration: on an install whose seed has not run yet the pricing
 * page must still render something truthful rather than an empty list, and the
 * amounts here are the ones the seed writes.
 */
import prisma from './prisma.js';
import { PLAN_FEATURE_KEYS, planFeatureMap, type PlanFeatureKey } from './planFeatures.js';
import { INCLUDED_USAGE, normalizeTier, tierLabel, type PlanTier } from './workspace.js';

export interface CatalogPlan {
  key: PlanTier;
  name: string;
  description: string | null;
  price_cents: number;
  price_yearly_cents: number | null;
  currency: string;
  interval: string;
  sort_order: number;
  highlighted: boolean;
  archived: boolean;
  trial_days: number;
  benefits: string[];
  features: Record<PlanFeatureKey, boolean>;
  limits: {
    ram_mb: number | null;
    cpus_milli: number | null;
    storage_mb: number | null;
    max_apps: number | null;
    max_domains: number | null;
    max_backups: number | null;
    max_members: number | null;
    max_databases: number | null;
    bandwidth_gb: number | null;
    instance_hours: number | null;
  };
}

/** The three billed keys, in display order. */
export const BILLED_PLAN_KEYS: PlanTier[] = ['hobby', 'pro', 'scale'];

const FALLBACK: Record<PlanTier, { price_cents: number; description: string; benefits: string[] }> = {
  hobby: {
    price_cents: 0,
    description: 'Free forever. Ship a side project on shared infrastructure.',
    benefits: ['750 instance hours / month', '100 GB bandwidth', '1 custom domain', 'Automatic HTTPS'],
  },
  pro: {
    price_cents: 1900,
    description: 'For production workloads that need headroom and a team.',
    benefits: ['1,000 instance hours / month', '500 GB bandwidth', '25 custom domains', 'Outbound webhooks + audit log'],
  },
  scale: {
    price_cents: 9900,
    description: 'Unlimited services, compliance controls and managed auth.',
    benefits: ['Unlimited instance hours', '1 TB bandwidth', 'Unlimited services and domains', 'Managed authentication'],
  },
};

/** `benefits` is a JSON column; anything that is not an array of strings is ignored. */
function benefitList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (strings.length) return strings;
  }
  return fallback;
}

function fallbackPlan(key: PlanTier): CatalogPlan {
  const base = FALLBACK[key];
  const usage = INCLUDED_USAGE[key];
  return {
    key,
    name: tierLabel(key),
    description: base.description,
    price_cents: base.price_cents,
    price_yearly_cents: base.price_cents ? base.price_cents * 10 : null,
    currency: 'USD',
    interval: 'month',
    sort_order: BILLED_PLAN_KEYS.indexOf(key) * 10 + 10,
    highlighted: key === 'pro',
    archived: false,
    trial_days: 0,
    benefits: base.benefits,
    features: planFeatureMap(null, key),
    limits: {
      ram_mb: null,
      cpus_milli: null,
      storage_mb: null,
      max_apps: usage.services,
      max_domains: usage.custom_domains,
      max_backups: null,
      max_members: null,
      max_databases: null,
      bandwidth_gb: usage.bandwidth_gb,
      instance_hours: usage.instance_hours,
    },
  };
}

/**
 * The customer-facing catalogue. Archived plans are excluded by default — §9 says a
 * retired plan disappears from signup while existing subscribers keep it — but an
 * admin view can ask for them.
 */
export async function planCatalog(options: { includeArchived?: boolean } = {}): Promise<CatalogPlan[]> {
  const rows = await prisma.plan.findMany({
    where: { key: { in: BILLED_PLAN_KEYS } },
    orderBy: [{ sort_order: 'asc' }, { price_cents: 'asc' }],
  });

  const byKey = new Map(rows.map((r) => [normalizeTier(r.key), r]));
  const out: CatalogPlan[] = [];

  for (const key of BILLED_PLAN_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      out.push(fallbackPlan(key));
      continue;
    }
    if (row.archived && !options.includeArchived) continue;
    out.push({
      key,
      name: row.name,
      description: row.description ?? FALLBACK[key].description,
      price_cents: row.price_cents,
      price_yearly_cents: row.price_yearly_cents ?? null,
      currency: row.currency,
      interval: row.interval,
      sort_order: row.sort_order,
      highlighted: row.highlighted,
      archived: row.archived,
      trial_days: row.trial_days ?? 0,
      benefits: benefitList(row.benefits, FALLBACK[key].benefits),
      features: planFeatureMap(row.features, key),
      limits: {
        ram_mb: row.ram_mb,
        cpus_milli: row.cpus_milli,
        storage_mb: row.storage_mb,
        max_apps: row.max_apps,
        max_domains: row.max_domains,
        max_backups: row.max_backups,
        max_members: row.max_members,
        max_databases: row.max_databases,
        bandwidth_gb: row.bandwidth_gb,
        instance_hours: row.instance_hours,
      },
    });
  }

  return out.sort((a, b) => a.sort_order - b.sort_order);
}

/** One billed plan, or NULL when the key is not part of the catalogue. */
export async function catalogPlan(key: string): Promise<CatalogPlan | null> {
  const wanted = (key || '').toLowerCase();
  if (!BILLED_PLAN_KEYS.includes(wanted as PlanTier)) return null;
  const all = await planCatalog({ includeArchived: true });
  return all.find((p) => p.key === wanted) ?? null;
}

/**
 * The amount a plan change should charge, in cents, for the chosen interval. The
 * *server* decides this; a client-supplied price is never trusted (§34).
 */
export function priceFor(plan: CatalogPlan, interval: 'month' | 'year'): number {
  if (interval === 'year') return plan.price_yearly_cents ?? plan.price_cents * 12;
  return plan.price_cents;
}

/** Feature keys, re-exported so route files need one import for the plan surface. */
export { PLAN_FEATURE_KEYS };
