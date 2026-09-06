/**
 * Plan feature toggles (spec §9).
 *
 * A plan row may carry a `features` JSON object of `{ [key]: boolean }`. This module
 * is the only reader, and it always falls back to the tier default from
 * `FEATURE_TIERS` — so a Plan row written before a feature existed never silently
 * disables it, and an operator who edits one toggle does not have to restate the
 * other ten.
 *
 * Precedence, highest first:
 *   1. explicit `true`/`false` on the plan row
 *   2. the tier default (`hobby` < `pro` < `scale`)
 *
 * §9 also says: "Changing plan configuration must NOT automatically change existing
 * user subscriptions." Nothing here writes; toggling a feature changes what the
 * plan *grants*, never which plan an account is on.
 */
import { FEATURE_TIERS, hasFeature, type FeatureKey, type PlanTier } from './workspace.js';

/**
 * Every toggle the plan manager exposes, with the tier that unlocks it by default
 * and a label the admin UI renders rather than hardcoding.
 *
 * The first seven are enforced by `<PlanGate/>` + the tier checks in
 * `routes/integrations.ts`; the last four are enforced by the numeric quota columns
 * next to them (`max_domains`, `max_databases`, `max_members`) and by the support
 * queue ordering. Nothing here is decorative.
 */
export const PLAN_FEATURES = {
  webhooks: { label: 'Outbound webhooks', tier: 'pro' },
  dedicated_ips: { label: 'Dedicated egress IPs', tier: 'pro' },
  security: { label: 'Security controls', tier: 'pro' },
  audit_logs: { label: 'Workspace audit log', tier: 'pro' },
  build_pipeline_performance: { label: 'Performance build pipeline', tier: 'pro' },
  authentication: { label: 'Managed authentication', tier: 'scale' },
  hipaa: { label: 'HIPAA configuration', tier: 'scale' },
  custom_domains: { label: 'Custom domains', tier: 'hobby' },
  databases: { label: 'Managed databases', tier: 'hobby' },
  team_members: { label: 'Team members', tier: 'pro' },
  priority_support: { label: 'Priority support', tier: 'pro' },
} as const satisfies Record<string, { label: string; tier: PlanTier }>;

export type PlanFeatureKey = keyof typeof PLAN_FEATURES;

export const PLAN_FEATURE_KEYS = Object.keys(PLAN_FEATURES) as PlanFeatureKey[];

/** True when `key` is also one of the tier-gated features in `FEATURE_TIERS`. */
function isTierFeature(key: PlanFeatureKey): key is PlanFeatureKey & FeatureKey {
  return key in FEATURE_TIERS;
}

/** `tier >= required`. */
function tierAtLeast(tier: PlanTier, required: PlanTier): boolean {
  const order: Record<PlanTier, number> = { hobby: 0, pro: 1, scale: 2 };
  return order[tier] >= order[required];
}

/**
 * The tier default for a toggle, used whenever the plan row says nothing. For the
 * seven features that also live in `FEATURE_TIERS`, `hasFeature()` stays the single
 * source of truth so the plan manager and `<PlanGate/>` can never disagree.
 */
export function defaultFeatureValue(key: PlanFeatureKey, tier: PlanTier): boolean {
  if (isTierFeature(key)) return hasFeature(tier, key);
  return tierAtLeast(tier, PLAN_FEATURES[key].tier);
}

/**
 * Is this feature on for a plan row? `features` is whatever came out of the JSON
 * column — an object, null, or (from a hand-edited row) something else entirely,
 * which is treated as "no opinion" rather than as an error.
 */
export function planFeature(
  features: unknown,
  key: PlanFeatureKey,
  tier: PlanTier,
): boolean {
  if (features && typeof features === 'object' && !Array.isArray(features)) {
    const value = (features as Record<string, unknown>)[key];
    if (typeof value === 'boolean') return value;
  }
  return defaultFeatureValue(key, tier);
}

/** Resolved toggles for a plan row, for the admin plan editor and the pricing card. */
export function planFeatureMap(
  features: unknown,
  tier: PlanTier,
): Record<PlanFeatureKey, boolean> {
  const out = {} as Record<PlanFeatureKey, boolean>;
  for (const key of PLAN_FEATURE_KEYS) out[key] = planFeature(features, key, tier);
  return out;
}

/** The seed shape for a tier: every toggle stated explicitly, so a row is readable. */
export function defaultFeatureSet(tier: PlanTier): Record<PlanFeatureKey, boolean> {
  const out = {} as Record<PlanFeatureKey, boolean>;
  for (const key of PLAN_FEATURE_KEYS) out[key] = defaultFeatureValue(key, tier);
  return out;
}

/**
 * Keep only known keys with boolean values from an admin-submitted toggle map.
 * Unknown keys are dropped rather than stored, so the column cannot accumulate
 * junk that looks like a feature.
 */
export function sanitizeFeatureInput(input: unknown): Record<string, boolean> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key of PLAN_FEATURE_KEYS) {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
  }
  return Object.keys(out).length ? out : null;
}
