-- AlterTable: add build/start/runtime fields to projects
ALTER TABLE "projects" ADD COLUMN "build_command" TEXT;
ALTER TABLE "projects" ADD COLUMN "start_command" TEXT;
ALTER TABLE "projects" ADD COLUMN "runtime_hint" TEXT;
