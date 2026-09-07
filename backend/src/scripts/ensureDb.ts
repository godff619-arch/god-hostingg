/**
 * Production DB bootstrap:
 * 1) Dedupe env_variables (so unique(project_id, service_name, key) can apply)
 * 2) prisma migrate deploy (checked-in migrations — never db push --accept-data-loss)
 * 3) Baseline legacy db-push installs, then repair any missing columns/indexes
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dedupeEnvVariables } from '../lib/envVariables.js';
import prisma from '../lib/prisma.js';
import { seedPlans, assignLegacyProjects } from './seedPlans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../..');

function runPrisma(args: string[]): void {
  execFileSync('npx', ['prisma', ...args], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
}

function assertSafeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

async function tableExists(name: string): Promise<boolean> {
  const safe = assertSafeIdent(name);
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${safe}'`
  );
  return rows.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const safeTable = assertSafeIdent(table);
  const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info(${safeTable})`
  );
  return cols.some((c) => c.name === column);
}

/** Idempotent repairs for installs that used `db push` before migrate history existed. */
export async function repairLegacySchema(): Promise<void> {
  if (!(await tableExists('projects'))) return;

  if (!(await columnExists('projects', 'publish_host_port'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "projects" ADD COLUMN "publish_host_port" BOOLEAN NOT NULL DEFAULT false`
    );
    console.log('[ensureDb] Added projects.publish_host_port');
  }

  if (!(await columnExists('projects', 'db_engine'))) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "projects" ADD COLUMN "db_engine" TEXT`);
    console.log('[ensureDb] Added projects.db_engine');
  }

  for (const col of ['build_command', 'start_command', 'runtime_hint']) {
    if (!(await columnExists('projects', col))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "projects" ADD COLUMN "${col}" TEXT`);
      console.log(`[ensureDb] Added projects.${col}`);
    }
  }

  if (!(await tableExists('database_links'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "database_links" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "database_project_id" TEXT NOT NULL,
        "app_project_id" TEXT NOT NULL,
        "service_name" TEXT NOT NULL DEFAULT '',
        "env_key" TEXT NOT NULL,
        "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "database_links_database_project_id_fkey" FOREIGN KEY ("database_project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "database_links_app_project_id_fkey" FOREIGN KEY ("app_project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "database_links_database_project_id_app_project_id_service_name_env_key_key" ON "database_links"("database_project_id", "app_project_id", "service_name", "env_key")`
    );
    console.log('[ensureDb] Created database_links');
  }

  if (await tableExists('database_links')) {
    // Keep newest link per (app, service, env_key) before unique index can apply
    await prisma.$executeRawUnsafe(`
      DELETE FROM "database_links"
      WHERE "id" IN (
        SELECT a."id" FROM "database_links" a
        INNER JOIN "database_links" b
          ON a."app_project_id" = b."app_project_id"
         AND a."service_name" = b."service_name"
         AND a."env_key" = b."env_key"
         AND (
           COALESCE(a."created_at", '') < COALESCE(b."created_at", '')
           OR (COALESCE(a."created_at", '') = COALESCE(b."created_at", '') AND a."id" < b."id")
         )
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "database_links_app_project_id_service_name_env_key_key" ON "database_links"("app_project_id", "service_name", "env_key")`
    );
  }

  if (await tableExists('deployments')) {
    if (!(await columnExists('deployments', 'commit_sha'))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "deployments" ADD COLUMN "commit_sha" TEXT`);
      console.log('[ensureDb] Added deployments.commit_sha');
    }
    if (!(await columnExists('deployments', 'image_tags'))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "deployments" ADD COLUMN "image_tags" TEXT`);
      console.log('[ensureDb] Added deployments.image_tags');
    }
  }

  if (await tableExists('env_variables')) {
    if (!(await columnExists('env_variables', 'is_secret'))) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "env_variables" ADD COLUMN "is_secret" BOOLEAN DEFAULT false`
      );
      console.log('[ensureDb] Added env_variables.is_secret');
    }

    const hasServiceScope = await columnExists('env_variables', 'service_name');
    if (hasServiceScope) {
      // Scoped env: unique is (project_id, service_name, key). Never recreate the
      // pre-scope (project_id, key) index — it blocks shared+service overrides.
      await prisma.$executeRawUnsafe(
        `DROP INDEX IF EXISTS "env_variables_project_id_key_key"`
      );
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "env_variables_project_id_service_name_key_key" ON "env_variables"("project_id", "service_name", "key")`
      );
    } else {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "env_variables_project_id_key_key" ON "env_variables"("project_id", "key")`
      );
    }
  }

  await repairMultiTenantSchema();
}

/**
 * Idempotent repairs for the multi-tenant foundation (plans, ownership, etc.).
 * Belt-and-suspenders for db-push-era installs whose migration history is
 * baselined only at _init. On the clean migrate path every guard is a no-op.
 */
async function repairMultiTenantSchema(): Promise<void> {
  if (await tableExists('users')) {
    if (!(await columnExists('users', 'plan_id'))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "plan_id" TEXT`);
      console.log('[ensureDb] Added users.plan_id');
    }
    if (!(await columnExists('users', 'status'))) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active'`
      );
      console.log('[ensureDb] Added users.status');
    }
    if (!(await columnExists('users', 'updated_at'))) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "users" ADD COLUMN "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP`
      );
      console.log('[ensureDb] Added users.updated_at');
    }
    // Per-user quota overrides (all nullable: NULL = inherit plan, integer = explicit cap)
    for (const col of [
      'ram_mb_override',
      'cpus_milli_override',
      'storage_mb_override',
      'max_apps_override',
      'max_domains_override',
      'max_backups_override',
    ]) {
      if (!(await columnExists('users', col))) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "${col}" INTEGER`);
        console.log(`[ensureDb] Added users.${col}`);
      }
    }
  }

  if (await tableExists('projects')) {
    if (!(await columnExists('projects', 'user_id'))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "projects" ADD COLUMN "user_id" TEXT`);
      console.log('[ensureDb] Added projects.user_id');
    }
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "projects_user_id_idx" ON "projects"("user_id")`
    );
  }

  if (!(await tableExists('plans'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "plans" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "key" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "price_cents" INTEGER NOT NULL DEFAULT 0,
        "currency" TEXT NOT NULL DEFAULT 'USD',
        "interval" TEXT NOT NULL DEFAULT 'month',
        "is_public" BOOLEAN NOT NULL DEFAULT true,
        "ram_mb" INTEGER,
        "cpus_milli" INTEGER,
        "storage_mb" INTEGER,
        "max_apps" INTEGER,
        "max_domains" INTEGER,
        "max_backups" INTEGER,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "plans_key_key" ON "plans"("key")`
    );
    console.log('[ensureDb] Created plans');
  }

  if (!(await tableExists('subscriptions'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "subscriptions" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "user_id" TEXT NOT NULL,
        "plan_id" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'active',
        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expires_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx" ON "subscriptions"("user_id")`
    );
    console.log('[ensureDb] Created subscriptions');
  }

  if (!(await tableExists('usage'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "usage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "user_id" TEXT NOT NULL,
        "metric" TEXT NOT NULL,
        "value" INTEGER NOT NULL DEFAULT 0,
        "period_start" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "usage_user_id_metric_key" ON "usage"("user_id", "metric")`
    );
    console.log('[ensureDb] Created usage');
  }

  if (!(await tableExists('notifications'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "notifications" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "user_id" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "body" TEXT,
        "read_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications"("user_id")`
    );
    console.log('[ensureDb] Created notifications');
  }

  if (!(await tableExists('audit_logs'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "audit_logs" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "user_id" TEXT,
        "action" TEXT NOT NULL,
        "resource" TEXT,
        "metadata" JSONB,
        "ip" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs"("user_id")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action")`
    );
    console.log('[ensureDb] Created audit_logs');
  }

  if (!(await tableExists('runtime_definitions'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "runtime_definitions" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "key" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "default_port" INTEGER NOT NULL DEFAULT 3000,
        "build_type" TEXT NOT NULL DEFAULT 'auto',
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "metadata" JSONB,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "runtime_definitions_key_key" ON "runtime_definitions"("key")`
    );
    console.log('[ensureDb] Created runtime_definitions');
  }

  await repairWorkspaceSchema();
}

/**
 * Workspace layer repair (User -> Workspace -> WorkspaceProject -> Environment
 * -> Project). Additive and idempotent: every ALTER is a nullable ADD COLUMN and
 * every CREATE is guarded, so re-running is a no-op and existing rows are kept.
 */
async function repairWorkspaceSchema(): Promise<void> {
  if (await tableExists('projects')) {
    for (const col of ['workspace_project_id', 'environment_id', 'region']) {
      if (!(await columnExists('projects', col))) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "projects" ADD COLUMN "${col}" TEXT`);
        console.log(`[ensureDb] Added projects.${col}`);
      }
    }
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "projects_workspace_project_id_idx" ON "projects"("workspace_project_id")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "projects_environment_id_idx" ON "projects"("environment_id")`
    );
  }

  for (const [table, ddl, indexes] of WORKSPACE_TABLES) {
    if (await tableExists(table)) continue;
    await prisma.$executeRawUnsafe(ddl);
    for (const idx of indexes) await prisma.$executeRawUnsafe(idx);
    console.log(`[ensureDb] Created ${table}`);
  }

  // The notification feed needs columns the original `notifications` table never
  // had. `severity` carries a default so pre-existing rows stay valid.
  if (await tableExists('notifications')) {
    const added: Array<[string, string]> = [
      ['workspace_id', 'TEXT'],
      ['severity', `TEXT NOT NULL DEFAULT 'info'`],
      ['resource', 'TEXT'],
      ['link', 'TEXT'],
    ];
    for (const [col, type] of added) {
      if (!(await columnExists('notifications', col))) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "notifications" ADD COLUMN "${col}" ${type}`);
        console.log(`[ensureDb] Added notifications.${col}`);
      }
    }
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "notifications_workspace_id_idx" ON "notifications"("workspace_id")`
    );
  }
}

/** [tableName, CREATE TABLE, index statements] — mirrors migrations/20260822180000_workspace_layer. */
const WORKSPACE_TABLES: Array<[string, string, string[]]> = [
  [
    'workspaces',
    `CREATE TABLE "workspaces" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "owner_id" TEXT NOT NULL,
      "name" TEXT NOT NULL DEFAULT 'My Workspace',
      "email" TEXT,
      "avatar" TEXT,
      "plan_key" TEXT NOT NULL DEFAULT 'hobby',
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [`CREATE INDEX IF NOT EXISTS "workspaces_owner_id_idx" ON "workspaces"("owner_id")`],
  ],
  [
    'workspace_projects',
    `CREATE TABLE "workspace_projects" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspace_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "workspace_projects_workspace_id_idx" ON "workspace_projects"("workspace_id")`,
    ],
  ],
  [
    'environments',
    `CREATE TABLE "environments" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_project_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "is_default" BOOLEAN NOT NULL DEFAULT false,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "environments_workspace_project_id_fkey" FOREIGN KEY ("workspace_project_id") REFERENCES "workspace_projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "environments_workspace_project_id_idx" ON "environments"("workspace_project_id")`,
    ],
  ],
  [
    'workspace_members',
    `CREATE TABLE "workspace_members" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "user_id" TEXT,
      "email" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'developer',
      "status" TEXT NOT NULL DEFAULT 'invited',
      "invited_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "joined_at" DATETIME,
      CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
      CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email")`,
      `CREATE INDEX IF NOT EXISTS "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id")`,
    ],
  ],
  [
    'billing_profiles',
    `CREATE TABLE "billing_profiles" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "company" TEXT,
      "address1" TEXT,
      "address2" TEXT,
      "city" TEXT,
      "state" TEXT,
      "postal_code" TEXT,
      "country" TEXT,
      "vat_id" TEXT,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "billing_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "billing_profiles_workspace_id_key" ON "billing_profiles"("workspace_id")`,
    ],
  ],
  [
    'payment_methods',
    `CREATE TABLE "payment_methods" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "provider" TEXT NOT NULL DEFAULT 'manual',
      "provider_ref" TEXT NOT NULL,
      "brand" TEXT NOT NULL,
      "last4" TEXT NOT NULL,
      "exp_month" INTEGER NOT NULL,
      "exp_year" INTEGER NOT NULL,
      "is_default" BOOLEAN NOT NULL DEFAULT false,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "payment_methods_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "payment_methods_workspace_id_idx" ON "payment_methods"("workspace_id")`,
    ],
  ],
  [
    'usage_records',
    `CREATE TABLE "usage_records" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "metric" TEXT NOT NULL,
      "bucket" TEXT,
      "resource_id" TEXT,
      "resource_name" TEXT,
      "resource_type" TEXT,
      "quantity" REAL NOT NULL DEFAULT 0,
      "unit" TEXT NOT NULL DEFAULT 'count',
      "rate_micros" INTEGER,
      "period" TEXT NOT NULL,
      "recorded_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "usage_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "usage_records_workspace_id_period_idx" ON "usage_records"("workspace_id", "period")`,
      `CREATE INDEX IF NOT EXISTS "usage_records_metric_idx" ON "usage_records"("metric")`,
    ],
  ],
  [
    'credit_balances',
    `CREATE TABLE "credit_balances" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "balance_cents" INTEGER NOT NULL DEFAULT 0,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "credit_balances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "credit_balances_workspace_id_key" ON "credit_balances"("workspace_id")`,
    ],
  ],
  [
    'promo_codes',
    `CREATE TABLE "promo_codes" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "code" TEXT NOT NULL,
      "amount_cents" INTEGER NOT NULL,
      "expires_at" DATETIME,
      "max_redemables" INTEGER,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    [`CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_key" ON "promo_codes"("code")`],
  ],
  [
    'promo_redemptions',
    `CREATE TABLE "promo_redemptions" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "promo_code_id" TEXT NOT NULL,
      "workspace_id" TEXT NOT NULL,
      "redeemed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "promo_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_promo_code_id_workspace_id_key" ON "promo_redemptions"("promo_code_id", "workspace_id")`,
    ],
  ],
  [
    'invoices',
    `CREATE TABLE "invoices" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "period_start" DATETIME NOT NULL,
      "period_end" DATETIME NOT NULL,
      "amount_cents" INTEGER NOT NULL DEFAULT 0,
      "currency" TEXT NOT NULL DEFAULT 'USD',
      "status" TEXT NOT NULL DEFAULT 'pending',
      "pdf_path" TEXT,
      "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "paid_at" DATETIME,
      CONSTRAINT "invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [`CREATE INDEX IF NOT EXISTS "invoices_workspace_id_idx" ON "invoices"("workspace_id")`],
  ],
  [
    'registry_credentials',
    `CREATE TABLE "registry_credentials" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "registry_host" TEXT,
      "username" TEXT NOT NULL,
      "secret_enc" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "registry_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "registry_credentials_workspace_id_idx" ON "registry_credentials"("workspace_id")`,
    ],
  ],
  [
    'webhooks',
    `CREATE TABLE "webhooks" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "url" TEXT NOT NULL,
      "secret_enc" TEXT NOT NULL,
      "events" JSONB NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "webhooks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [`CREATE INDEX IF NOT EXISTS "webhooks_workspace_id_idx" ON "webhooks"("workspace_id")`],
  ],
  [
    'webhook_deliveries',
    `CREATE TABLE "webhook_deliveries" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "webhook_id" TEXT NOT NULL,
      "event" TEXT NOT NULL,
      "status_code" INTEGER,
      "error" TEXT,
      "duration_ms" INTEGER,
      "attempted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries"("webhook_id")`,
    ],
  ],
  [
    'dedicated_ips',
    `CREATE TABLE "dedicated_ips" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "address" TEXT NOT NULL,
      "region" TEXT,
      "status" TEXT NOT NULL DEFAULT 'provisioning',
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "dedicated_ips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "dedicated_ips_workspace_id_idx" ON "dedicated_ips"("workspace_id")`,
    ],
  ],
  [
    'observability_streams',
    `CREATE TABLE "observability_streams" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "provider" TEXT NOT NULL DEFAULT 'custom',
      "endpoint" TEXT,
      "secret_enc" TEXT,
      "enabled" BOOLEAN NOT NULL DEFAULT false,
      "include_preview" BOOLEAN NOT NULL DEFAULT false,
      "last_test" TEXT NOT NULL DEFAULT 'untested',
      "last_test_at" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "observability_streams_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "observability_streams_workspace_id_kind_key" ON "observability_streams"("workspace_id", "kind")`,
    ],
  ],
  [
    'workspace_settings',
    `CREATE TABLE "workspace_settings" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "pipeline_tier" TEXT NOT NULL DEFAULT 'starter',
      "pipeline_spend_limit_cents" INTEGER,
      "deploy_policy" TEXT NOT NULL DEFAULT 'override',
      "require_2fa" BOOLEAN NOT NULL DEFAULT false,
      "session_timeout_minutes" INTEGER,
      "ip_allowlist" TEXT,
      "security_alerts" BOOLEAN NOT NULL DEFAULT true,
      "saml_enabled" BOOLEAN NOT NULL DEFAULT false,
      "saml_metadata_url" TEXT,
      "scim_enabled" BOOLEAN NOT NULL DEFAULT false,
      "hipaa_enabled" BOOLEAN NOT NULL DEFAULT false,
      "hipaa_accepted_at" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspace_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "workspace_settings_workspace_id_key" ON "workspace_settings"("workspace_id")`,
    ],
  ],
  // Environment Groups — mirrors migrations/20260823_env_groups.
  [
    'env_groups',
    `CREATE TABLE "env_groups" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "env_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "env_groups_workspace_id_name_key" ON "env_groups"("workspace_id", "name")`,
      `CREATE INDEX IF NOT EXISTS "env_groups_workspace_id_idx" ON "env_groups"("workspace_id")`,
    ],
  ],
  [
    'env_group_vars',
    `CREATE TABLE "env_group_vars" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "group_id" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "value_enc" TEXT NOT NULL,
      "is_secret" BOOLEAN NOT NULL DEFAULT false,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "env_group_vars_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "env_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "env_group_vars_group_id_key_key" ON "env_group_vars"("group_id", "key")`,
      `CREATE INDEX IF NOT EXISTS "env_group_vars_group_id_idx" ON "env_group_vars"("group_id")`,
    ],
  ],
  [
    'env_group_links',
    `CREATE TABLE "env_group_links" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "group_id" TEXT NOT NULL,
      "environment_id" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "env_group_links_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "env_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
      CONSTRAINT "env_group_links_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "env_group_links_group_id_environment_id_key" ON "env_group_links"("group_id", "environment_id")`,
      `CREATE INDEX IF NOT EXISTS "env_group_links_environment_id_idx" ON "env_group_links"("environment_id")`,
    ],
  ],
  // Notifications — mirrors migrations/20260823_notifications.
  [
    'notification_settings',
    `CREATE TABLE "notification_settings" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "default_level" TEXT NOT NULL DEFAULT 'failure',
      "include_preview" BOOLEAN NOT NULL DEFAULT false,
      "events" JSONB NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "notification_settings_workspace_id_key" ON "notification_settings"("workspace_id")`,
    ],
  ],
  [
    'notification_channels',
    `CREATE TABLE "notification_channels" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "target_enc" TEXT NOT NULL,
      "hint" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "last_result" TEXT,
      "last_sent_at" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "notification_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "notification_channels_workspace_id_idx" ON "notification_channels"("workspace_id")`,
    ],
  ],
  // Private Links — mirrors migrations/20260823_private_links.
  [
    'private_links',
    `CREATE TABLE "private_links" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "source_project_id" TEXT NOT NULL,
      "target_project_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "target_port" INTEGER NOT NULL,
      "scheme" TEXT NOT NULL DEFAULT 'http',
      "env_key" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "last_error" TEXT,
      "last_applied_at" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "private_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
      CONSTRAINT "private_links_source_project_id_fkey" FOREIGN KEY ("source_project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
      CONSTRAINT "private_links_target_project_id_fkey" FOREIGN KEY ("target_project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "private_links_source_target_port_key" ON "private_links"("source_project_id", "target_project_id", "target_port")`,
      `CREATE INDEX IF NOT EXISTS "private_links_workspace_id_idx" ON "private_links"("workspace_id")`,
      `CREATE INDEX IF NOT EXISTS "private_links_source_project_id_idx" ON "private_links"("source_project_id")`,
      `CREATE INDEX IF NOT EXISTS "private_links_target_project_id_idx" ON "private_links"("target_project_id")`,
    ],
  ],
  // Blueprints — mirrors migrations/20260823_blueprints.
  [
    'blueprints',
    `CREATE TABLE IF NOT EXISTS "blueprints" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "workspace_id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "source" TEXT NOT NULL DEFAULT 'manual',
      "repo_url" TEXT,
      "repo_branch" TEXT,
      "spec_path" TEXT,
      "spec" TEXT NOT NULL,
      "spec_format" TEXT NOT NULL DEFAULT 'yaml',
      "last_synced_at" DATETIME,
      "last_sync_error" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "blueprints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "blueprints_workspace_id_name_key" ON "blueprints"("workspace_id", "name")`,
      `CREATE INDEX IF NOT EXISTS "blueprints_workspace_id_idx" ON "blueprints"("workspace_id")`,
    ],
  ],
  [
    'blueprint_applies',
    `CREATE TABLE IF NOT EXISTS "blueprint_applies" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "blueprint_id" TEXT NOT NULL,
      "workspace_project_id" TEXT,
      "environment_id" TEXT,
      "status" TEXT NOT NULL DEFAULT 'running',
      "created_count" INTEGER NOT NULL DEFAULT 0,
      "skipped_count" INTEGER NOT NULL DEFAULT 0,
      "failed_count" INTEGER NOT NULL DEFAULT 0,
      "log" TEXT NOT NULL DEFAULT '',
      "error" TEXT,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finished_at" DATETIME,
      CONSTRAINT "blueprint_applies_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`,
    [
      `CREATE INDEX IF NOT EXISTS "blueprint_applies_blueprint_id_idx" ON "blueprint_applies"("blueprint_id")`,
    ],
  ],
  // Error Center — mirrors migrations/20260823_error_events.
  [
    'error_events',
    `CREATE TABLE IF NOT EXISTS "error_events" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "fingerprint" TEXT NOT NULL,
      "level" TEXT NOT NULL DEFAULT 'error',
      "source" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "detail" TEXT,
      "route" TEXT,
      "status_code" INTEGER,
      "request_id" TEXT,
      "user_id" TEXT,
      "workspace_id" TEXT,
      "resource" TEXT,
      "count" INTEGER NOT NULL DEFAULT 1,
      "first_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "resolved_at" DATETIME,
      "resolved_by" TEXT,
      CONSTRAINT "error_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
    )`,
    [
      `CREATE UNIQUE INDEX IF NOT EXISTS "error_events_fingerprint_key" ON "error_events"("fingerprint")`,
      `CREATE INDEX IF NOT EXISTS "error_events_source_idx" ON "error_events"("source")`,
      `CREATE INDEX IF NOT EXISTS "error_events_last_seen_at_idx" ON "error_events"("last_seen_at")`,
      `CREATE INDEX IF NOT EXISTS "error_events_resolved_at_idx" ON "error_events"("resolved_at")`,
    ],
  ],
  [
    'platform_uptime',
    `CREATE TABLE IF NOT EXISTS "platform_uptime" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "ended_at" DATETIME,
      "clean_exit" BOOLEAN NOT NULL DEFAULT false,
      "gap_seconds" INTEGER NOT NULL DEFAULT 0,
      "version" TEXT
    )`,
    [`CREATE INDEX IF NOT EXISTS "platform_uptime_started_at_idx" ON "platform_uptime"("started_at")`],
  ],
];

async function migrationHistoryEmpty(): Promise<boolean> {
  if (!(await tableExists('_prisma_migrations'))) return true;
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
    `SELECT COUNT(*) as c FROM "_prisma_migrations"`
  );
  return Number(rows[0]?.c ?? 0) === 0;
}

async function baselineLegacyIfNeeded(): Promise<void> {
  const hasProjects = await tableExists('projects');
  if (!hasProjects) return;
  if (!(await migrationHistoryEmpty())) return;

  console.log('[ensureDb] Legacy database detected (no migration history) — baselining init');
  runPrisma(['migrate', 'resolve', '--applied', '20260725120000_init']);
}

async function main() {
  try {
    if (await tableExists('env_variables')) {
      const removed = await dedupeEnvVariables();
      if (removed > 0) {
        console.log(`[ensureDb] Removed ${removed} duplicate env_variables row(s)`);
      }
    }
  } catch (err) {
    console.warn('[ensureDb] Dedupe skipped:', err);
  }

  try {
    runPrisma(['migrate', 'deploy']);
  } catch (firstErr) {
    console.warn('[ensureDb] migrate deploy failed — attempting legacy baseline:', firstErr);
    try {
      // Baseline only — do NOT repair columns before migrate, or ADD COLUMN
      // migrations (e.g. db_engine) fail with "duplicate column name".
      await baselineLegacyIfNeeded();
      runPrisma(['migrate', 'deploy']);
    } catch (secondErr) {
      console.error('[ensureDb] migrate deploy failed after baseline:', secondErr);
      process.exit(1);
    }
  }

  try {
    await repairLegacySchema();
  } catch (err) {
    console.error('[ensureDb] Schema repair failed:', err);
    process.exit(1);
  }

  try {
    await seedPlans();
    await assignLegacyProjects();
  } catch (err) {
    console.error('[ensureDb] Plan seed / legacy assignment failed:', err);
    process.exit(1);
  }

  await prisma.$disconnect();
  console.log('[ensureDb] Database ready');
}

main().catch(async (err) => {
  console.error('[ensureDb] Failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
