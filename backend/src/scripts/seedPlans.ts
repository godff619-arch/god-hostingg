/**
 * Seed default plans and backfill legacy project ownership.
 * Idempotent: safe to run on every boot. Runs after migrate deploy + repairLegacySchema.
 *
 * - seedPlans(): upserts Free/Premium/Admin keyed on Plan.key. Empty `update` = pure
 *   no-op on re-run, preserving any operator edits to plan names/prices/quotas.
 *   Unlimited quotas are represented explicitly as NULL columns (never Infinity/magic ints).
 * - assignLegacyProjects(): assigns pre-multi-tenancy projects (user_id IS NULL) to the
 *   bootstrap admin. No-op on fresh installs (no users) and on re-run (nothing left null).
 */
import prisma from '../lib/prisma.js';

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
