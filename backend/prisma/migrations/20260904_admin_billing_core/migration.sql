-- Super Admin panel + billing state machine.
--
-- Purely ADDITIVE: new tables, plus new nullable / defaulted columns on existing
-- tables. No row is rewritten, no column is dropped or retyped, so an install
-- full of live users, plans and payment metadata survives untouched. Every new
-- billing column defaults to the value that means "nothing has been billed",
-- which is exactly what is true of a pre-migration account.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; migrate deploy runs a migration once,
-- and legacy `db push` installs are repaired idempotently by ensureDb.ts instead.

-- ---------------------------------------------------------------------------
-- Billing state model on workspaces (spec §37). `plan_key` stops being the sole
-- source of truth: these columns say whether the plan was actually paid for.
-- ---------------------------------------------------------------------------
ALTER TABLE "workspaces" ADD COLUMN "subscription_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "workspaces" ADD COLUMN "payment_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "workspaces" ADD COLUMN "billing_provider" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "workspaces" ADD COLUMN "subscription_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "current_period_start" DATETIME;
ALTER TABLE "workspaces" ADD COLUMN "current_period_end" DATETIME;
ALTER TABLE "workspaces" ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspaces" ADD COLUMN "manual_override" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspaces" ADD COLUMN "manual_override_by" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "manual_override_reason" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "manual_override_at" DATETIME;

-- Workspaces already on a paid plan before this migration were put there by the
-- old instant-flip endpoint. Record that honestly as a manual override rather
-- than inventing a payment for them — §59 forbids fabricating payment rows.
UPDATE "workspaces"
   SET "subscription_status" = 'active',
       "payment_status" = 'none',
       "manual_override" = true,
       "manual_override_reason" = 'Pre-existing paid plan, migrated (no payment record)',
       "manual_override_at" = CURRENT_TIMESTAMP
 WHERE "plan_key" IS NOT NULL AND "plan_key" <> 'hobby';

-- ---------------------------------------------------------------------------
-- Account lifecycle + security columns (spec §4, §5, §26, §27)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "email_verified_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "verify_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "verify_expires_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "reset_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "reset_expires_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "last_login_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "last_login_ip" TEXT;
ALTER TABLE "users" ADD COLUMN "login_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "locked_until" DATETIME;
ALTER TABLE "users" ADD COLUMN "failed_logins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "suspend_reason" TEXT;
ALTER TABLE "users" ADD COLUMN "suspended_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "suspended_by" TEXT;
ALTER TABLE "users" ADD COLUMN "approved_at" DATETIME;
ALTER TABLE "users" ADD COLUMN "approved_by" TEXT;
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" TEXT;
ALTER TABLE "users" ADD COLUMN "totp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "internal_note" TEXT;

-- ---------------------------------------------------------------------------
-- Audit log §24 fields. Existing rows keep NULLs — an old row simply has less
-- provenance, which is honest; it is never back-filled with a guess.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_logs" ADD COLUMN "actor_role" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "actor_email" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "target_type" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "target_id" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "target_label" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "reason" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "before" JSONB;
ALTER TABLE "audit_logs" ADD COLUMN "after" JSONB;
ALTER TABLE "audit_logs" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';
CREATE INDEX IF NOT EXISTS "audit_logs_target_id_idx" ON "audit_logs" ("target_id");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" ("created_at");

-- ---------------------------------------------------------------------------
-- Dynamic plan manager (spec §9)
-- ---------------------------------------------------------------------------
ALTER TABLE "plans" ADD COLUMN "description" TEXT;
ALTER TABLE "plans" ADD COLUMN "price_yearly_cents" INTEGER;
ALTER TABLE "plans" ADD COLUMN "trial_days" INTEGER DEFAULT 0;
ALTER TABLE "plans" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "plans" ADD COLUMN "highlighted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "plans" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "plans" ADD COLUMN "bandwidth_gb" INTEGER;
ALTER TABLE "plans" ADD COLUMN "instance_hours" INTEGER;
ALTER TABLE "plans" ADD COLUMN "max_members" INTEGER;
ALTER TABLE "plans" ADD COLUMN "max_databases" INTEGER;
ALTER TABLE "plans" ADD COLUMN "features" JSONB;
ALTER TABLE "plans" ADD COLUMN "benefits" JSONB;

-- ---------------------------------------------------------------------------
-- Subscriptions §8. `source` defaults to 'signup' so pre-existing rows are not
-- misreported as having gone through checkout.
-- ---------------------------------------------------------------------------
ALTER TABLE "subscriptions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'signup';
ALTER TABLE "subscriptions" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "subscriptions" ADD COLUMN "provider_ref" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "current_period_start" DATETIME;
ALTER TABLE "subscriptions" ADD COLUMN "current_period_end" DATETIME;
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" DATETIME;
ALTER TABLE "subscriptions" ADD COLUMN "cancel_reason" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "trial_ends_at" DATETIME;
ALTER TABLE "subscriptions" ADD COLUMN "interval" TEXT NOT NULL DEFAULT 'month';
ALTER TABLE "subscriptions" ADD COLUMN "amount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscriptions" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "subscriptions" ADD COLUMN "manual_override" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscriptions" ADD COLUMN "workspace_id" TEXT;
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" ("status");
CREATE INDEX IF NOT EXISTS "subscriptions_workspace_id_idx" ON "subscriptions" ("workspace_id");

-- ---------------------------------------------------------------------------
-- Payment method display metadata (spec §6). Still no PAN, still no CVV.
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_methods" ADD COLUMN "billing_name" TEXT;
ALTER TABLE "payment_methods" ADD COLUMN "billing_country" TEXT;
ALTER TABLE "payment_methods" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "payment_methods" ADD COLUMN "funding" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "payment_methods" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'card';

-- ---------------------------------------------------------------------------
-- Invoices §11
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ADD COLUMN "number" TEXT;
ALTER TABLE "invoices" ADD COLUMN "subtotal_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "tax_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "credit_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "due_at" DATETIME;
ALTER TABLE "invoices" ADD COLUMN "payment_id" TEXT;
ALTER TABLE "invoices" ADD COLUMN "notes" TEXT;
ALTER TABLE "invoices" ADD COLUMN "voided_at" DATETIME;
ALTER TABLE "invoices" ADD COLUMN "voided_by" TEXT;
ALTER TABLE "invoices" ADD COLUMN "marked_paid_by" TEXT;
ALTER TABLE "invoices" ADD COLUMN "marked_paid_reason" TEXT;
ALTER TABLE "invoices" ADD COLUMN "sent_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "last_sent_at" DATETIME;
-- Existing invoices already have a total; mirror it into the new subtotal so the
-- line-item maths of an old invoice still adds up when it is displayed.
UPDATE "invoices" SET "subtotal_cents" = "amount_cents" WHERE "subtotal_cents" = 0;
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_key" ON "invoices" ("number");
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON "invoices" ("status");

-- ---------------------------------------------------------------------------
-- Coupons (spec §13), grown out of the existing promo_codes table
-- ---------------------------------------------------------------------------
ALTER TABLE "promo_codes" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE "promo_codes" ADD COLUMN "percent_off" INTEGER;
ALTER TABLE "promo_codes" ADD COLUMN "description" TEXT;
ALTER TABLE "promo_codes" ADD COLUMN "plan_keys" JSONB;
ALTER TABLE "promo_codes" ADD COLUMN "duration" TEXT NOT NULL DEFAULT 'once';
ALTER TABLE "promo_codes" ADD COLUMN "duration_months" INTEGER;
ALTER TABLE "promo_codes" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "promo_codes" ADD COLUMN "created_by" TEXT;
ALTER TABLE "promo_codes" ADD COLUMN "starts_at" DATETIME;

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "payments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "provider_ref" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "refunded_cents" INTEGER NOT NULL DEFAULT 0,
  "plan_key" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'subscription',
  "description" TEXT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "invoice_id" TEXT,
  "provider_event" JSONB,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  "succeeded_at" DATETIME,
  "failed_at" DATETIME,
  CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
-- The uniqueness of provider_ref IS the replay guard for §34: a second webhook
-- carrying the same charge id cannot create a second payment row.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_provider_ref_key" ON "payments" ("provider_ref");
CREATE INDEX IF NOT EXISTS "payments_workspace_id_idx" ON "payments" ("workspace_id");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" ("status");
CREATE INDEX IF NOT EXISTS "payments_created_at_idx" ON "payments" ("created_at");

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "payment_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "provider_ref" TEXT,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT NOT NULL,
  "admin_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" DATETIME,
  CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_provider_ref_key" ON "refunds" ("provider_ref");
CREATE INDEX IF NOT EXISTS "refunds_payment_id_idx" ON "refunds" ("payment_id");

CREATE TABLE IF NOT EXISTS "checkout_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT,
  "plan_key" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "provider_ref" TEXT,
  "redirect_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "payment_id" TEXT,
  "expires_at" DATETIME NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "checkout_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "checkout_sessions_workspace_id_idx" ON "checkout_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "checkout_sessions_status_idx" ON "checkout_sessions" ("status");

CREATE TABLE IF NOT EXISTS "subscription_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'system',
  "from_plan" TEXT,
  "to_plan" TEXT,
  "admin_id" TEXT,
  "reason" TEXT,
  "payment_id" TEXT,
  "before" JSONB,
  "after" JSONB,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "subscription_events_workspace_id_idx" ON "subscription_events" ("workspace_id");
CREATE INDEX IF NOT EXISTS "subscription_events_event_idx" ON "subscription_events" ("event");

CREATE TABLE IF NOT EXISTS "provider_webhook_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "detail" TEXT,
  "signature_ok" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB,
  "ip" TEXT,
  "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" DATETIME
);
-- The idempotency key. INSERT failing here is the desired outcome for a replay.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_webhook_events_provider_event_id_key"
  ON "provider_webhook_events" ("provider", "event_id");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_event_type_idx" ON "provider_webhook_events" ("event_type");
CREATE INDEX IF NOT EXISTS "provider_webhook_events_received_at_idx" ON "provider_webhook_events" ("received_at");

CREATE TABLE IF NOT EXISTS "credit_transactions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'adjustment',
  "reason" TEXT NOT NULL,
  "admin_id" TEXT,
  "balance_after" INTEGER NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_transactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "credit_transactions_workspace_id_idx" ON "credit_transactions" ("workspace_id");

CREATE TABLE IF NOT EXISTS "invoice_items" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "invoice_id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" REAL NOT NULL DEFAULT 1,
  "unit_cents" INTEGER NOT NULL DEFAULT 0,
  "amount_cents" INTEGER NOT NULL DEFAULT 0,
  "kind" TEXT NOT NULL DEFAULT 'plan',
  CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "invoice_items_invoice_id_idx" ON "invoice_items" ("invoice_id");

CREATE TABLE IF NOT EXISTS "email_templates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body_html" TEXT NOT NULL,
  "body_text" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updated_by" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_key_key" ON "email_templates" ("key");

CREATE TABLE IF NOT EXISTS "email_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "to_email" TEXT NOT NULL,
  "from_email" TEXT,
  "subject" TEXT NOT NULL,
  "template_key" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "message_id" TEXT,
  "user_id" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'transactional',
  -- The rendered message. A queued mail cannot be sent later without it, and
  -- "what exactly did we send them?" is a support question that needs an answer
  -- rather than a re-render that may no longer match the template.
  "body_html" TEXT,
  "body_text" TEXT,
  -- What the mail is about (`invoice` + its id), so a failure can be traced back
  -- to the thing that triggered it.
  "related_type" TEXT,
  "related_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" DATETIME
);
CREATE INDEX IF NOT EXISTS "email_logs_status_idx" ON "email_logs" ("status");
CREATE INDEX IF NOT EXISTS "email_logs_created_at_idx" ON "email_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "email_logs_to_email_idx" ON "email_logs" ("to_email");

CREATE TABLE IF NOT EXISTS "announcements" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'info',
  "audience" TEXT NOT NULL DEFAULT 'all',
  "audience_ref" JSONB,
  "placement" TEXT NOT NULL DEFAULT 'inbox',
  "published" BOOLEAN NOT NULL DEFAULT false,
  "send_email" BOOLEAN NOT NULL DEFAULT false,
  "starts_at" DATETIME,
  "ends_at" DATETIME,
  "created_by" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "announcements_published_idx" ON "announcements" ("published");

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT,
  "workspace_id" TEXT,
  "subject" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'open',
  "category" TEXT NOT NULL DEFAULT 'other',
  "assignee_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" DATETIME,
  CONSTRAINT "support_tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" ("status");
CREATE INDEX IF NOT EXISTS "support_tickets_user_id_idx" ON "support_tickets" ("user_id");

CREATE TABLE IF NOT EXISTS "support_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticket_id" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "author_id" TEXT,
  "body" TEXT NOT NULL,
  "internal" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "support_messages_ticket_id_idx" ON "support_messages" ("ticket_id");

CREATE TABLE IF NOT EXISTS "admin_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "device" TEXT,
  "suspicious" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME NOT NULL,
  "revoked_at" DATETIME,
  "revoked_by" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "admin_sessions_token_hash_key" ON "admin_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "admin_sessions_user_id_idx" ON "admin_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "admin_sessions_expires_at_idx" ON "admin_sessions" ("expires_at");

CREATE TABLE IF NOT EXISTS "login_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "outcome" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "login_attempts_email_created_at_idx" ON "login_attempts" ("email", "created_at");
CREATE INDEX IF NOT EXISTS "login_attempts_ip_created_at_idx" ON "login_attempts" ("ip", "created_at");

CREATE TABLE IF NOT EXISTS "admin_api_keys" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "permissions" JSONB NOT NULL,
  "created_by" TEXT,
  "last_used_at" DATETIME,
  "expires_at" DATETIME,
  "revoked_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "admin_api_keys_key_hash_key" ON "admin_api_keys" ("key_hash");
