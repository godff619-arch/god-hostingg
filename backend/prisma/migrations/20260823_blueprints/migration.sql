-- Blueprints: infrastructure-as-code for a workspace (Part A → Blueprints).
--
-- Additive only. `blueprints` holds the spec verbatim so an apply can be
-- re-read exactly as it ran; `blueprint_applies` is immutable run history with
-- the per-item outcome counts and the log, so a partial apply stays visible
-- instead of being reported as a success.
CREATE TABLE IF NOT EXISTS "blueprints" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "workspace_id"    TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "source"          TEXT NOT NULL DEFAULT 'manual',
  "repo_url"        TEXT,
  "repo_branch"     TEXT,
  "spec_path"       TEXT,
  "spec"            TEXT NOT NULL,
  "spec_format"     TEXT NOT NULL DEFAULT 'yaml',
  "last_synced_at"  DATETIME,
  "last_sync_error" TEXT,
  "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blueprints_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Names are how people refer to a blueprint, so they are unique per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "blueprints_workspace_id_name_key"
  ON "blueprints" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "blueprints_workspace_id_idx" ON "blueprints" ("workspace_id");

CREATE TABLE IF NOT EXISTS "blueprint_applies" (
  "id"                   TEXT NOT NULL PRIMARY KEY,
  "blueprint_id"         TEXT NOT NULL,
  "workspace_project_id" TEXT,
  "environment_id"       TEXT,
  "status"               TEXT NOT NULL DEFAULT 'running',
  "created_count"        INTEGER NOT NULL DEFAULT 0,
  "skipped_count"        INTEGER NOT NULL DEFAULT 0,
  "failed_count"         INTEGER NOT NULL DEFAULT 0,
  "log"                  TEXT NOT NULL DEFAULT '',
  "error"                TEXT,
  "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"          DATETIME,
  CONSTRAINT "blueprint_applies_blueprint_id_fkey" FOREIGN KEY ("blueprint_id")
    REFERENCES "blueprints" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "blueprint_applies_blueprint_id_idx"
  ON "blueprint_applies" ("blueprint_id");
