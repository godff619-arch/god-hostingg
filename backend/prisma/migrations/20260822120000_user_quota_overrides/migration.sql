-- Per-user quota overrides. All nullable: NULL = inherit the plan value; an integer = explicit cap.
-- Additive ALTER TABLE ... ADD COLUMN, safe on existing rows (no default needed for nullable columns).
ALTER TABLE "users" ADD COLUMN "ram_mb_override" INTEGER;
ALTER TABLE "users" ADD COLUMN "cpus_milli_override" INTEGER;
ALTER TABLE "users" ADD COLUMN "storage_mb_override" INTEGER;
ALTER TABLE "users" ADD COLUMN "max_apps_override" INTEGER;
ALTER TABLE "users" ADD COLUMN "max_domains_override" INTEGER;
ALTER TABLE "users" ADD COLUMN "max_backups_override" INTEGER;
