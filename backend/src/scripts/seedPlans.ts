/**
 * Seed default plans and backfill legacy project ownership.
 * Idempotent: safe to run on every boot. Runs after migrate deploy + repairLegacySchema.
 *
 * - seedPlans(): upserts the plan catalogue keyed on Plan.key. Empty `update` = pure
 *   no-op on re-run, preserving any operator edits to plan names/prices/quotas.
 *   Unlimited quotas are represented explicitly as NULL columns (never Infinity/magic ints).
 * - assignLegacyProjects(): assigns pre-multi-tenancy projects (user_id IS NULL) to the
 *   bootstrap admin. No-op on fresh installs (no users) and on re-run (nothing left null).
 *
 * TWO KEY VOCABULARIES, ON PURPOSE
 * --------------------------------
 * `free | premium | admin` are the original rows. `User.plan_id` points at them and
 * existing installs have real users attached, so they are never renamed or removed.
 *
 * `hobby | pro | scale` are the billed tiers: `Workspace.plan_key`, `PlanTier`,
 * `INCLUDED_USAGE` and the pricing page all speak this vocabulary, and the billing
 * state machine resolves them with `prisma.plan.findUnique({ where: { key } })`.
 * Without these rows a paid activation could not mirror onto `Subscription` /
 * `User.plan_id`, and a downgrade could not find the free row to fall back to.
 *
 * Their quotas are deliberately >= the legacy row they correspond to, so an account
 * that moves across (hobby <- free, pro <- premium) never loses capacity it had.
 */
import prisma from '../lib/prisma.js';
import { defaultFeatureSet } from '../lib/planFeatures.js';
import type { PlanTier } from '../lib/workspace.js';

interface PlanSeed {
  key: string;
  name: string;
  price_cents: number;
  is_public: boolean;
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
  // -- §9 fields. Only the billed tiers carry these; the legacy rows keep their
  // original shape so re-running the seed cannot rewrite them.
  tier?: PlanTier;
  description?: string;
  price_yearly_cents?: number | null;
  sort_order?: number;
  highlighted?: boolean;
  bandwidth_gb?: number | null;
  instance_hours?: number | null;
  max_members?: number | null;
  max_databases?: number | null;
  benefits?: string[];
}

// NULL = unlimited (explicit). 1 GB = 1024 MB, 10 GB = 10240 MB. cpus_milli: 1000 = 1.0 CPU.
const PLAN_SEEDS: PlanSeed[] = [
  {
    key: 'free',
    name: 'Free',
    price_cents: 0,
    is_public: true,
    ram_mb: 500,
    cpus_milli: 500,
    storage_mb: 1024,
    max_apps: 2,
    max_domains: 1,
    max_backups: 1,
  },
  {
    key: 'premium',
    name: 'Premium',
    price_cents: 0, // billing phase sets the real price
    is_public: true,
    ram_mb: 2048,
    cpus_milli: 2000,
    storage_mb: 10240,
    max_apps: 10,
    max_domains: 10,
    max_backups: 10,
  },
  {
    key: 'admin',
    name: 'Admin',
    price_cents: 0,
    is_public: false,
    ram_mb: null,
    cpus_milli: null,
    storage_mb: null,
    max_apps: null,
    max_domains: null,
    max_backups: null,
  },

  // -- The billed catalogue (Workspace.plan_key / PlanTier) --
  {
    key: 'hobby',
    name: 'Hobby',
    price_cents: 0,
    price_yearly_cents: null,
    is_public: true,
    tier: 'hobby',
    description: 'Free forever. Ship a side project on shared infrastructure.',
    sort_order: 10,
    // Matches the legacy `free` row rather than INCLUDED_USAGE.services, which is a
    // metered monthly allowance, not a hard cap.
    ram_mb: 512,
    cpus_milli: 500,
    storage_mb: 1024,
    max_apps: 2,
    max_domains: 1,
    max_backups: 1,
    bandwidth_gb: 100,
    instance_hours: 750,
    max_members: 1,
    max_databases: 1,
    benefits: [
      '750 instance hours / month',
      '100 GB bandwidth',
      '1 custom domain',
      'Automatic HTTPS',
      'Deploy from Git',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price_cents: 1900,
    price_yearly_cents: 19000, // two months free
    is_public: true,
    tier: 'pro',
    description: 'For production workloads that need headroom and a team.',
    sort_order: 20,
    highlighted: true,
    ram_mb: 4096,
    cpus_milli: 4000,
    storage_mb: 25600,
    max_apps: 50,
    max_domains: 25,
    max_backups: 30,
    bandwidth_gb: 500,
    instance_hours: 1000,
    max_members: 10,
    max_databases: 10,
    benefits: [
      '1,000 instance hours / month',
      '500 GB bandwidth',
      '25 custom domains',
      'Up to 10 team members',
      'Outbound webhooks + audit log',
      'Performance build pipeline',
    ],
  },
  {
    key: 'scale',
    name: 'Scale',
    price_cents: 9900,
    price_yearly_cents: 99000,
    is_public: true,
    tier: 'scale',
    description: 'Unlimited services, compliance controls and managed auth.',
    sort_order: 30,
    ram_mb: 16384,
    cpus_milli: 8000,
    storage_mb: 102400,
    max_apps: null,
    max_domains: null,
    max_backups: null,
    bandwidth_gb: 1000,
    instance_hours: null,
    max_members: null,
    max_databases: null,
    benefits: [
      'Unlimited instance hours',
      '1 TB bandwidth',
      'Unlimited services and domains',
      'Unlimited team members',
      'Managed authentication',
      'HIPAA configuration',
    ],
  },
];

interface RuntimeSeed {
  key: string;
  name: string;
  default_port: number;
  build_type: string;
  sort_order: number;
}

const RUNTIME_SEEDS: RuntimeSeed[] = [
  { key: 'node', name: 'Node.js', default_port: 3000, build_type: 'auto', sort_order: 10 },
  { key: 'python', name: 'Python', default_port: 8000, build_type: 'auto', sort_order: 20 },
  { key: 'static', name: 'Static Site', default_port: 80, build_type: 'auto', sort_order: 30 },
  { key: 'docker', name: 'Dockerfile', default_port: 3000, build_type: 'dockerfile', sort_order: 40 },
];

export async function seedPlans(): Promise<void> {
  for (const p of PLAN_SEEDS) {
    await prisma.plan.upsert({
      where: { key: p.key },
      create: {
        key: p.key,
        name: p.name,
        price_cents: p.price_cents,
        is_public: p.is_public,
        ram_mb: p.ram_mb,
        cpus_milli: p.cpus_milli,
        storage_mb: p.storage_mb,
        max_apps: p.max_apps,
        max_domains: p.max_domains,
        max_backups: p.max_backups,
        description: p.description ?? null,
        price_yearly_cents: p.price_yearly_cents ?? null,
        sort_order: p.sort_order ?? 0,
        highlighted: p.highlighted ?? false,
        bandwidth_gb: p.bandwidth_gb ?? null,
        instance_hours: p.instance_hours ?? null,
        max_members: p.max_members ?? null,
        max_databases: p.max_databases ?? null,
        // Every toggle stated explicitly so the row reads as its own documentation;
        // `planFeature()` would fall back to the tier default anyway.
        features: p.tier ? defaultFeatureSet(p.tier) : undefined,
        benefits: p.benefits ?? undefined,
      },
      update: {}, // no-op on re-run; preserve operator edits
    });
  }

  for (const r of RUNTIME_SEEDS) {
    await prisma.runtimeDefinition.upsert({
      where: { key: r.key },
      create: {
        key: r.key,
        name: r.name,
        default_port: r.default_port,
        build_type: r.build_type,
        sort_order: r.sort_order,
      },
      update: {},
    });
  }

  console.log('[ensureDb] Plans and runtime definitions seeded');
}

export async function assignLegacyProjects(): Promise<void> {
  const admin =
    (await prisma.user.findFirst({
      where: { role: { in: ['owner', 'super_admin', 'admin'] } },
      orderBy: { created_at: 'asc' },
    })) ??
    (await prisma.user.findFirst({ orderBy: { created_at: 'asc' } }));

  if (!admin) {
    // Fresh install — no users yet, nothing to assign. New projects always set user_id.
    return;
  }

  const result = await prisma.project.updateMany({
    where: { user_id: null },
    data: { user_id: admin.id },
  });

  if (result.count > 0) {
    console.log(`[ensureDb] Assigned ${result.count} legacy project(s) to admin ${admin.id}`);
  }

  // Keep the admin's plan_id consistent (admins bypass quotas regardless).
  if (!admin.plan_id) {
    const adminPlan = await prisma.plan.findUnique({ where: { key: 'admin' } });
    if (adminPlan) {
      await prisma.user.update({
        where: { id: admin.id },
        data: { plan_id: adminPlan.id },
      });
    }
  }
}
