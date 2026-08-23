-- Error Center: grouped platform error events.
-- One row per fingerprint (source + route + normalized message), so a route that
-- throws 400 times is one row with count = 400 rather than 400 unread rows.

CREATE TABLE IF NOT EXISTS "error_events" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "error_events_fingerprint_key" ON "error_events"("fingerprint");
CREATE INDEX IF NOT EXISTS "error_events_source_idx" ON "error_events"("source");
CREATE INDEX IF NOT EXISTS "error_events_last_seen_at_idx" ON "error_events"("last_seen_at");
CREATE INDEX IF NOT EXISTS "error_events_resolved_at_idx" ON "error_events"("resolved_at");
