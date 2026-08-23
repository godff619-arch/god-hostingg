-- Environment Groups: reusable env-var sets linked to environments.
-- Purely additive — three new tables, no existing table or row is touched.

CREATE TABLE IF NOT EXISTS "env_groups" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "env_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "env_groups_workspace_id_name_key" ON "env_groups" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "env_groups_workspace_id_idx" ON "env_groups" ("workspace_id");

CREATE TABLE IF NOT EXISTS "env_group_vars" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "group_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value_enc" TEXT NOT NULL,
  "is_secret" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "env_group_vars_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "env_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "env_group_vars_group_id_key_key" ON "env_group_vars" ("group_id", "key");
CREATE INDEX IF NOT EXISTS "env_group_vars_group_id_idx" ON "env_group_vars" ("group_id");

CREATE TABLE IF NOT EXISTS "env_group_links" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "group_id" TEXT NOT NULL,
  "environment_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "env_group_links_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "env_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "env_group_links_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "env_group_links_group_id_environment_id_key" ON "env_group_links" ("group_id", "environment_id");
CREATE INDEX IF NOT EXISTS "env_group_links_environment_id_idx" ON "env_group_links" ("environment_id");
