-- Notifications: delivery preferences, outbound channels, and the extra columns
-- the in-app feed needs on the existing `notifications` table.
--
-- Additive only. Every ADD COLUMN is nullable or carries a default, so existing
-- rows keep their meaning and re-running against a partially migrated database
-- is safe.

-- The `notifications` table predates the feed; these columns were never there.
ALTER TABLE "notifications" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "notifications" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "notifications" ADD COLUMN "resource" TEXT;
ALTER TABLE "notifications" ADD COLUMN "link" TEXT;

CREATE INDEX IF NOT EXISTS "notifications_workspace_id_idx" ON "notifications"("workspace_id");

CREATE TABLE IF NOT EXISTS "notification_settings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "default_level" TEXT NOT NULL DEFAULT 'failure',
  "include_preview" BOOLEAN NOT NULL DEFAULT false,
  "events" JSONB NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_settings_workspace_id_key" ON "notification_settings"("workspace_id");

CREATE TABLE IF NOT EXISTS "notification_channels" (
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
);

CREATE INDEX IF NOT EXISTS "notification_channels_workspace_id_idx" ON "notification_channels"("workspace_id");
