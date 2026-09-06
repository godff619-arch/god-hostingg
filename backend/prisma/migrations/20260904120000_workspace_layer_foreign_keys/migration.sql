-- Referential integrity for the workspace layer (and the three older tables that
-- never got theirs).
--
-- `20260822180000_workspace_layer` created sixteen tables with no FOREIGN KEY
-- clauses at all, even though the Prisma schema declares every one of those
-- relations with `onDelete: Cascade`. SQLite therefore never cascaded: deleting a
-- user left its workspaces behind, deleting a workspace left its cards, invoices,
-- webhooks and usage rows behind. Prisma's query engine then reads a row whose
-- required parent is missing and throws
--
--   Inconsistent query result: Field workspace is required to return data, got null
--
-- which turns one stale row into a 500 for a whole admin page (this is what broke
-- GET /api/admin/cards). `users`, `projects`, `deployments` and `notifications`
-- were missing theirs for the same reason, so they are repaired in the same pass.
--
-- Two halves, and both are needed:
--   1. RedefineTables — SQLite cannot ALTER a constraint in, so each table is
--      rebuilt with its FKs. Generated from the schema, so the column sets are
--      exactly what the datamodel declares.
--   2. Purge — a rebuild copies the orphans across, and SQLite tolerates
--      pre-existing violations (it only enforces on later writes). The DELETEs at
--      the end are what actually clears the rows Prisma is choking on. They run
--      parents-first so a purge cascades by hand the way the FK would have.
--
-- Rows are only removed where the schema says the parent is required; where the
-- column is nullable the reference is nulled instead, which keeps the row.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_billing_profiles" (
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
);
INSERT INTO "new_billing_profiles" ("address1", "address2", "city", "company", "country", "id", "postal_code", "state", "updated_at", "vat_id", "workspace_id") SELECT "address1", "address2", "city", "company", "country", "id", "postal_code", "state", "updated_at", "vat_id", "workspace_id" FROM "billing_profiles";
DROP TABLE "billing_profiles";
ALTER TABLE "new_billing_profiles" RENAME TO "billing_profiles";
CREATE UNIQUE INDEX "billing_profiles_workspace_id_key" ON "billing_profiles"("workspace_id");
CREATE TABLE "new_credit_balances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_balances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_credit_balances" ("balance_cents", "id", "updated_at", "workspace_id") SELECT "balance_cents", "id", "updated_at", "workspace_id" FROM "credit_balances";
DROP TABLE "credit_balances";
ALTER TABLE "new_credit_balances" RENAME TO "credit_balances";
CREATE UNIQUE INDEX "credit_balances_workspace_id_key" ON "credit_balances"("workspace_id");
CREATE TABLE "new_dedicated_ips" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dedicated_ips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_dedicated_ips" ("address", "created_at", "id", "region", "status", "workspace_id") SELECT "address", "created_at", "id", "region", "status", "workspace_id" FROM "dedicated_ips";
DROP TABLE "dedicated_ips";
ALTER TABLE "new_dedicated_ips" RENAME TO "dedicated_ips";
CREATE INDEX "dedicated_ips_workspace_id_idx" ON "dedicated_ips"("workspace_id");
CREATE TABLE "new_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "status" TEXT,
    "trigger" TEXT DEFAULT 'manual',
    "commit_message" TEXT,
    "commit_sha" TEXT,
    "image_tags" JSONB,
    "logs" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "finished_at" DATETIME,
    CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_deployments" ("commit_message", "commit_sha", "created_at", "finished_at", "id", "image_tags", "logs", "project_id", "status", "trigger") SELECT "commit_message", "commit_sha", "created_at", "finished_at", "id", "image_tags", "logs", "project_id", "status", "trigger" FROM "deployments";
DROP TABLE "deployments";
ALTER TABLE "new_deployments" RENAME TO "deployments";
CREATE TABLE "new_environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environments_workspace_project_id_fkey" FOREIGN KEY ("workspace_project_id") REFERENCES "workspace_projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_environments" ("created_at", "id", "is_default", "name", "workspace_project_id") SELECT "created_at", "id", "is_default", "name", "workspace_project_id" FROM "environments";
DROP TABLE "environments";
ALTER TABLE "new_environments" RENAME TO "environments";
CREATE INDEX "environments_workspace_project_id_idx" ON "environments"("workspace_project_id");
CREATE TABLE "new_invoices" (
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
    "number" TEXT,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_cents" INTEGER NOT NULL DEFAULT 0,
    "due_at" DATETIME,
    "payment_id" TEXT,
    "notes" TEXT,
    "voided_at" DATETIME,
    "voided_by" TEXT,
    "marked_paid_by" TEXT,
    "marked_paid_reason" TEXT,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" DATETIME,
    CONSTRAINT "invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_invoices" ("amount_cents", "credit_cents", "currency", "discount_cents", "due_at", "id", "issued_at", "last_sent_at", "marked_paid_by", "marked_paid_reason", "notes", "number", "paid_at", "payment_id", "pdf_path", "period_end", "period_start", "sent_count", "status", "subtotal_cents", "tax_cents", "voided_at", "voided_by", "workspace_id") SELECT "amount_cents", "credit_cents", "currency", "discount_cents", "due_at", "id", "issued_at", "last_sent_at", "marked_paid_by", "marked_paid_reason", "notes", "number", "paid_at", "payment_id", "pdf_path", "period_end", "period_start", "sent_count", "status", "subtotal_cents", "tax_cents", "voided_at", "voided_by", "workspace_id" FROM "invoices";
DROP TABLE "invoices";
ALTER TABLE "new_invoices" RENAME TO "invoices";
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");
CREATE INDEX "invoices_workspace_id_idx" ON "invoices"("workspace_id");
CREATE INDEX "invoices_status_idx" ON "invoices"("status");
CREATE TABLE "new_notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "resource" TEXT,
    "link" TEXT,
    "read_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_notifications" ("body", "created_at", "id", "link", "read_at", "resource", "severity", "title", "type", "user_id", "workspace_id") SELECT "body", "created_at", "id", "link", "read_at", "resource", "severity", "title", "type", "user_id", "workspace_id" FROM "notifications";
DROP TABLE "notifications";
ALTER TABLE "new_notifications" RENAME TO "notifications";
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");
CREATE INDEX "notifications_workspace_id_idx" ON "notifications"("workspace_id");
CREATE TABLE "new_observability_streams" (
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
);
INSERT INTO "new_observability_streams" ("created_at", "enabled", "endpoint", "id", "include_preview", "kind", "last_test", "last_test_at", "provider", "secret_enc", "updated_at", "workspace_id") SELECT "created_at", "enabled", "endpoint", "id", "include_preview", "kind", "last_test", "last_test_at", "provider", "secret_enc", "updated_at", "workspace_id" FROM "observability_streams";
DROP TABLE "observability_streams";
ALTER TABLE "new_observability_streams" RENAME TO "observability_streams";
CREATE UNIQUE INDEX "observability_streams_workspace_id_kind_key" ON "observability_streams"("workspace_id", "kind");
CREATE TABLE "new_payment_methods" (
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
    "billing_name" TEXT,
    "billing_country" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "funding" TEXT NOT NULL DEFAULT 'unknown',
    "type" TEXT NOT NULL DEFAULT 'card',
    CONSTRAINT "payment_methods_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_payment_methods" ("billing_country", "billing_name", "brand", "created_at", "exp_month", "exp_year", "funding", "id", "is_default", "last4", "provider", "provider_ref", "status", "type", "workspace_id") SELECT "billing_country", "billing_name", "brand", "created_at", "exp_month", "exp_year", "funding", "id", "is_default", "last4", "provider", "provider_ref", "status", "type", "workspace_id" FROM "payment_methods";
DROP TABLE "payment_methods";
ALTER TABLE "new_payment_methods" RENAME TO "payment_methods";
CREATE INDEX "payment_methods_workspace_id_idx" ON "payment_methods"("workspace_id");
CREATE TABLE "new_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source_type" TEXT,
    "project_type" TEXT,
    "github_url" TEXT,
    "github_branch" TEXT,
    "domain" TEXT,
    "port" INTEGER,
    "status" TEXT,
    "container_name" TEXT,
    "auto_deploy" BOOLEAN DEFAULT false,
    "webhook_secret" TEXT,
    "build_type" TEXT NOT NULL DEFAULT 'auto',
    "base_directory" TEXT NOT NULL DEFAULT '.',
    "dockerfile_path" TEXT,
    "internal_port" INTEGER NOT NULL DEFAULT 3000,
    "publish_host_port" BOOLEAN NOT NULL DEFAULT false,
    "db_engine" TEXT,
    "user_id" TEXT,
    "workspace_project_id" TEXT,
    "environment_id" TEXT,
    "region" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "projects_workspace_project_id_fkey" FOREIGN KEY ("workspace_project_id") REFERENCES "workspace_projects" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "projects_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_projects" ("auto_deploy", "base_directory", "build_type", "container_name", "created_at", "db_engine", "description", "dockerfile_path", "domain", "environment_id", "github_branch", "github_url", "id", "internal_port", "name", "port", "project_type", "publish_host_port", "region", "source_type", "status", "updated_at", "user_id", "webhook_secret", "workspace_project_id") SELECT "auto_deploy", "base_directory", "build_type", "container_name", "created_at", "db_engine", "description", "dockerfile_path", "domain", "environment_id", "github_branch", "github_url", "id", "internal_port", "name", "port", "project_type", "publish_host_port", "region", "source_type", "status", "updated_at", "user_id", "webhook_secret", "workspace_project_id" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");
CREATE INDEX "projects_workspace_project_id_idx" ON "projects"("workspace_project_id");
CREATE INDEX "projects_environment_id_idx" ON "projects"("environment_id");
CREATE TABLE "new_promo_redemptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promo_code_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "redeemed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promo_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_promo_redemptions" ("id", "promo_code_id", "redeemed_at", "workspace_id") SELECT "id", "promo_code_id", "redeemed_at", "workspace_id" FROM "promo_redemptions";
DROP TABLE "promo_redemptions";
ALTER TABLE "new_promo_redemptions" RENAME TO "promo_redemptions";
CREATE UNIQUE INDEX "promo_redemptions_promo_code_id_workspace_id_key" ON "promo_redemptions"("promo_code_id", "workspace_id");
CREATE TABLE "new_registry_credentials" (
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
);
INSERT INTO "new_registry_credentials" ("created_at", "id", "name", "provider", "registry_host", "secret_enc", "updated_at", "username", "workspace_id") SELECT "created_at", "id", "name", "provider", "registry_host", "secret_enc", "updated_at", "username", "workspace_id" FROM "registry_credentials";
DROP TABLE "registry_credentials";
ALTER TABLE "new_registry_credentials" RENAME TO "registry_credentials";
CREATE INDEX "registry_credentials_workspace_id_idx" ON "registry_credentials"("workspace_id");
CREATE TABLE "new_usage_records" (
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
);
INSERT INTO "new_usage_records" ("bucket", "id", "metric", "period", "quantity", "rate_micros", "recorded_at", "resource_id", "resource_name", "resource_type", "unit", "workspace_id") SELECT "bucket", "id", "metric", "period", "quantity", "rate_micros", "recorded_at", "resource_id", "resource_name", "resource_type", "unit", "workspace_id" FROM "usage_records";
DROP TABLE "usage_records";
ALTER TABLE "new_usage_records" RENAME TO "usage_records";
CREATE INDEX "usage_records_workspace_id_period_idx" ON "usage_records"("workspace_id", "period");
CREATE INDEX "usage_records_metric_idx" ON "usage_records"("metric");
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "plan_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ram_mb_override" INTEGER,
    "cpus_milli_override" INTEGER,
    "storage_mb_override" INTEGER,
    "max_apps_override" INTEGER,
    "max_domains_override" INTEGER,
    "max_backups_override" INTEGER,
    "passwordChangedAt" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "email_verified" BOOLEAN NOT NULL DEFAULT true,
    "email_verified_at" DATETIME,
    "verify_token_hash" TEXT,
    "verify_expires_at" DATETIME,
    "reset_token_hash" TEXT,
    "reset_expires_at" DATETIME,
    "last_login_at" DATETIME,
    "last_login_ip" TEXT,
    "login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" DATETIME,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "suspend_reason" TEXT,
    "suspended_at" DATETIME,
    "suspended_by" TEXT,
    "approved_at" DATETIME,
    "approved_by" TEXT,
    "totp_secret_enc" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "internal_note" TEXT,
    CONSTRAINT "users_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_users" ("approved_at", "approved_by", "cpus_milli_override", "created_at", "email", "email_verified", "email_verified_at", "failed_logins", "id", "internal_note", "last_login_at", "last_login_ip", "locked_until", "login_count", "max_apps_override", "max_backups_override", "max_domains_override", "name", "password", "passwordChangedAt", "plan_id", "ram_mb_override", "reset_expires_at", "reset_token_hash", "role", "status", "storage_mb_override", "suspend_reason", "suspended_at", "suspended_by", "totp_enabled", "totp_secret_enc", "updated_at", "verify_expires_at", "verify_token_hash") SELECT "approved_at", "approved_by", "cpus_milli_override", "created_at", "email", "email_verified", "email_verified_at", "failed_logins", "id", "internal_note", "last_login_at", "last_login_ip", "locked_until", "login_count", "max_apps_override", "max_backups_override", "max_domains_override", "name", "password", "passwordChangedAt", "plan_id", "ram_mb_override", "reset_expires_at", "reset_token_hash", "role", "status", "storage_mb_override", "suspend_reason", "suspended_at", "suspended_by", "totp_enabled", "totp_secret_enc", "updated_at", "verify_expires_at", "verify_token_hash" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE TABLE "new_webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,
    "duration_ms" INTEGER,
    "attempted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_webhook_deliveries" ("attempted_at", "duration_ms", "error", "event", "id", "status_code", "webhook_id") SELECT "attempted_at", "duration_ms", "error", "event", "id", "status_code", "webhook_id" FROM "webhook_deliveries";
DROP TABLE "webhook_deliveries";
ALTER TABLE "new_webhook_deliveries" RENAME TO "webhook_deliveries";
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries"("webhook_id");
CREATE TABLE "new_webhooks" (
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
);
INSERT INTO "new_webhooks" ("created_at", "enabled", "events", "id", "name", "secret_enc", "updated_at", "url", "workspace_id") SELECT "created_at", "enabled", "events", "id", "name", "secret_enc", "updated_at", "url", "workspace_id" FROM "webhooks";
DROP TABLE "webhooks";
ALTER TABLE "new_webhooks" RENAME TO "webhooks";
CREATE INDEX "webhooks_workspace_id_idx" ON "webhooks"("workspace_id");
CREATE TABLE "new_workspace_members" (
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
);
INSERT INTO "new_workspace_members" ("email", "id", "invited_at", "joined_at", "role", "status", "user_id", "workspace_id") SELECT "email", "id", "invited_at", "joined_at", "role", "status", "user_id", "workspace_id" FROM "workspace_members";
DROP TABLE "workspace_members";
ALTER TABLE "new_workspace_members" RENAME TO "workspace_members";
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id");
CREATE UNIQUE INDEX "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email");
CREATE TABLE "new_workspace_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_workspace_projects" ("created_at", "description", "id", "name", "updated_at", "workspace_id") SELECT "created_at", "description", "id", "name", "updated_at", "workspace_id" FROM "workspace_projects";
DROP TABLE "workspace_projects";
ALTER TABLE "new_workspace_projects" RENAME TO "workspace_projects";
CREATE INDEX "workspace_projects_workspace_id_idx" ON "workspace_projects"("workspace_id");
CREATE TABLE "new_workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Workspace',
    "email" TEXT,
    "avatar" TEXT,
    "plan_key" TEXT NOT NULL DEFAULT 'hobby',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "subscription_status" TEXT NOT NULL DEFAULT 'none',
    "payment_status" TEXT NOT NULL DEFAULT 'none',
    "billing_provider" TEXT NOT NULL DEFAULT 'manual',
    "subscription_id" TEXT,
    "current_period_start" DATETIME,
    "current_period_end" DATETIME,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "manual_override" BOOLEAN NOT NULL DEFAULT false,
    "manual_override_by" TEXT,
    "manual_override_reason" TEXT,
    "manual_override_at" DATETIME,
    CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_workspaces" ("avatar", "billing_provider", "cancel_at_period_end", "created_at", "current_period_end", "current_period_start", "email", "id", "manual_override", "manual_override_at", "manual_override_by", "manual_override_reason", "name", "owner_id", "payment_status", "plan_key", "subscription_id", "subscription_status", "updated_at") SELECT "avatar", "billing_provider", "cancel_at_period_end", "created_at", "current_period_end", "current_period_start", "email", "id", "manual_override", "manual_override_at", "manual_override_by", "manual_override_reason", "name", "owner_id", "payment_status", "plan_key", "subscription_id", "subscription_status", "updated_at" FROM "workspaces";
DROP TABLE "workspaces";
ALTER TABLE "new_workspaces" RENAME TO "workspaces";
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- RedefineIndex
DROP INDEX "private_links_source_target_port_key";
CREATE UNIQUE INDEX "private_links_source_project_id_target_project_id_target_port_key" ON "private_links"("source_project_id", "target_project_id", "target_port");

-- ── Purge the rows the missing cascades left behind ──────────────────────────
-- Ordered parents-first: clearing a workspace whose owner is gone must happen
-- before its children are checked, or the children look valid and survive.

-- Plan deleted while users still pointed at it.
UPDATE "users" SET "plan_id" = NULL
  WHERE "plan_id" IS NOT NULL AND "plan_id" NOT IN (SELECT "id" FROM "plans");

-- Owner account deleted: the whole workspace should have gone with it.
DELETE FROM "workspaces"
  WHERE "owner_id" NOT IN (SELECT "id" FROM "users");

DELETE FROM "workspace_projects"
  WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "environments"
  WHERE "workspace_project_id" NOT IN (SELECT "id" FROM "workspace_projects");

-- Projects survive their owner and their workspace (the schema says SET NULL) —
-- a running container must not disappear because a membership row did.
UPDATE "projects" SET "user_id" = NULL
  WHERE "user_id" IS NOT NULL AND "user_id" NOT IN (SELECT "id" FROM "users");
UPDATE "projects" SET "workspace_project_id" = NULL
  WHERE "workspace_project_id" IS NOT NULL
    AND "workspace_project_id" NOT IN (SELECT "id" FROM "workspace_projects");
UPDATE "projects" SET "environment_id" = NULL
  WHERE "environment_id" IS NOT NULL
    AND "environment_id" NOT IN (SELECT "id" FROM "environments");

DELETE FROM "deployments"
  WHERE "project_id" NOT IN (SELECT "id" FROM "projects");

-- Workspace-scoped children. Every one of these is a required relation, so an
-- orphan is unreadable through Prisma and can only be removed.
DELETE FROM "workspace_members" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
UPDATE "workspace_members" SET "user_id" = NULL
  WHERE "user_id" IS NOT NULL AND "user_id" NOT IN (SELECT "id" FROM "users");
DELETE FROM "billing_profiles" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "payment_methods" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "usage_records" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "credit_balances" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "invoices" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "registry_credentials" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "webhooks" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "dedicated_ips" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "observability_streams" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "workspace_settings" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "private_links" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");

-- Notifications keep their user (required) but the workspace link is optional.
DELETE FROM "notifications" WHERE "user_id" NOT IN (SELECT "id" FROM "users");
UPDATE "notifications" SET "workspace_id" = NULL
  WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "workspaces");

DELETE FROM "webhook_deliveries" WHERE "webhook_id" NOT IN (SELECT "id" FROM "webhooks");
DELETE FROM "promo_redemptions" WHERE "promo_code_id" NOT IN (SELECT "id" FROM "promo_codes");

-- Billing core: these were created with their FKs, but a workspace purged above
-- takes its money rows with it, so the same pass has to reach them.
DELETE FROM "payments" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "refunds" WHERE "payment_id" NOT IN (SELECT "id" FROM "payments");
DELETE FROM "checkout_sessions" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "subscription_events" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "credit_transactions" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "invoice_items" WHERE "invoice_id" NOT IN (SELECT "id" FROM "invoices");

-- A support ticket outlives its workspace on purpose (SET NULL): the conversation
-- is still the only record of what was asked.
UPDATE "support_tickets" SET "workspace_id" = NULL
  WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "support_messages" WHERE "ticket_id" NOT IN (SELECT "id" FROM "support_tickets");

