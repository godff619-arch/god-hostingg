-- Workspace layer (additive only).
-- Hierarchy: User -> Workspace -> WorkspaceProject -> Environment -> Project.
-- Every ALTER adds a nullable column, so existing rows survive untouched.

ALTER TABLE "projects" ADD COLUMN "workspace_project_id" TEXT;
ALTER TABLE "projects" ADD COLUMN "environment_id" TEXT;
ALTER TABLE "projects" ADD COLUMN "region" TEXT;

CREATE INDEX IF NOT EXISTS "projects_workspace_project_id_idx" ON "projects"("workspace_project_id");
CREATE INDEX IF NOT EXISTS "projects_environment_id_idx" ON "projects"("environment_id");

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'My Workspace',
  "email" TEXT,
  "avatar" TEXT,
  "plan_key" TEXT NOT NULL DEFAULT 'hobby',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workspaces_owner_id_idx" ON "workspaces"("owner_id");

CREATE TABLE IF NOT EXISTS "workspace_projects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workspace_projects_workspace_id_idx" ON "workspace_projects"("workspace_id");

CREATE TABLE IF NOT EXISTS "environments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "environments_workspace_project_id_idx" ON "environments"("workspace_project_id");

CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'developer',
  "status" TEXT NOT NULL DEFAULT 'invited',
  "invited_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "joined_at" DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email");
CREATE INDEX IF NOT EXISTS "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id");

CREATE TABLE IF NOT EXISTS "billing_profiles" (
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
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "billing_profiles_workspace_id_key" ON "billing_profiles"("workspace_id");

CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "provider_ref" TEXT NOT NULL,
  "brand" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "exp_month" INTEGER NOT NULL,
  "exp_year" INTEGER NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "payment_methods_workspace_id_idx" ON "payment_methods"("workspace_id");

CREATE TABLE IF NOT EXISTS "usage_records" (
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
  "recorded_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "usage_records_workspace_id_period_idx" ON "usage_records"("workspace_id", "period");
CREATE INDEX IF NOT EXISTS "usage_records_metric_idx" ON "usage_records"("metric");

CREATE TABLE IF NOT EXISTS "credit_balances" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "balance_cents" INTEGER NOT NULL DEFAULT 0,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_balances_workspace_id_key" ON "credit_balances"("workspace_id");

CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "expires_at" DATETIME,
  "max_redemables" INTEGER,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_key" ON "promo_codes"("code");

CREATE TABLE IF NOT EXISTS "promo_redemptions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "promo_code_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "redeemed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_promo_code_id_workspace_id_key" ON "promo_redemptions"("promo_code_id", "workspace_id");

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "period_start" DATETIME NOT NULL,
  "period_end" DATETIME NOT NULL,
  "amount_cents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "pdf_path" TEXT,
  "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at" DATETIME
);
CREATE INDEX IF NOT EXISTS "invoices_workspace_id_idx" ON "invoices"("workspace_id");

CREATE TABLE IF NOT EXISTS "registry_credentials" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "registry_host" TEXT,
  "username" TEXT NOT NULL,
  "secret_enc" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "registry_credentials_workspace_id_idx" ON "registry_credentials"("workspace_id");

CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret_enc" TEXT NOT NULL,
  "events" JSONB NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "webhooks_workspace_id_idx" ON "webhooks"("workspace_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "webhook_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "status_code" INTEGER,
  "error" TEXT,
  "duration_ms" INTEGER,
  "attempted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries"("webhook_id");

CREATE TABLE IF NOT EXISTS "dedicated_ips" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "region" TEXT,
  "status" TEXT NOT NULL DEFAULT 'provisioning',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "dedicated_ips_workspace_id_idx" ON "dedicated_ips"("workspace_id");

CREATE TABLE IF NOT EXISTS "observability_streams" (
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
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "observability_streams_workspace_id_kind_key" ON "observability_streams"("workspace_id", "kind");
