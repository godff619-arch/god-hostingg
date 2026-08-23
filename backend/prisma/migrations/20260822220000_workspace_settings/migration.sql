-- Workspace Settings: per-workspace build pipeline, deploy policy, security, SSO
-- and HIPAA state. Additive only — a new table, so existing rows are untouched.
CREATE TABLE "workspace_settings" (
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
);

CREATE UNIQUE INDEX "workspace_settings_workspace_id_key" ON "workspace_settings"("workspace_id");
