-- Multi-tenant foundation: ownership, plans, subscriptions, usage, notifications, audit logs, runtime catalog.
-- Purely additive. Nullable/defaulted columns so ADD COLUMN is safe on existing populated rows.

-- Users: SaaS columns
ALTER TABLE "users" ADD COLUMN "plan_id" TEXT;
ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Projects: ownership (nullable for legacy backfill)
ALTER TABLE "projects" ADD COLUMN "user_id" TEXT;
CREATE INDEX IF NOT EXISTS "projects_user_id_idx" ON "projects"("user_id");

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
);
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

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
);
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions"("user_id");

CREATE TABLE "usage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "period_start" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "usage_user_id_metric_key" ON "usage"("user_id", "metric");

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "read_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT,
  "metadata" JSONB,
  "ip" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

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
);
CREATE UNIQUE INDEX "runtime_definitions_key_key" ON "runtime_definitions"("key");
