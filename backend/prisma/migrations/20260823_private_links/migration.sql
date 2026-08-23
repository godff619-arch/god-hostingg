-- Private Links: service-to-service internal networking (Part A → NETWORKING).
--
-- Additive only. A link records the intent (source, target, port, optional env
-- key) plus the honest result of the last Docker attach, so the UI can show
-- "error" with the daemon's own reason instead of assuming success.
CREATE TABLE IF NOT EXISTS "private_links" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "workspace_id"      TEXT NOT NULL,
  "source_project_id" TEXT NOT NULL,
  "target_project_id" TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "target_port"       INTEGER NOT NULL,
  "scheme"            TEXT NOT NULL DEFAULT 'http',
  "env_key"           TEXT,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "last_error"        TEXT,
  "last_applied_at"   DATETIME,
  "created_at"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "private_links_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "private_links_source_project_id_fkey" FOREIGN KEY ("source_project_id")
    REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "private_links_target_project_id_fkey" FOREIGN KEY ("target_project_id")
    REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- One link per (consumer, provider, port); re-requesting the same pair is an
-- update, not a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS "private_links_source_target_port_key"
  ON "private_links" ("source_project_id", "target_project_id", "target_port");
CREATE INDEX IF NOT EXISTS "private_links_workspace_id_idx" ON "private_links" ("workspace_id");
CREATE INDEX IF NOT EXISTS "private_links_source_project_id_idx" ON "private_links" ("source_project_id");
CREATE INDEX IF NOT EXISTS "private_links_target_project_id_idx" ON "private_links" ("target_project_id");
