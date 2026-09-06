// Shared TypeScript types for the Admin Dashboard pages.
// Mirrors the backend `/api/admin` contract.

import type { Project } from "@/lib/types";

export type UserRole =
  | "user"
  | "viewer"
  | "support_admin"
  | "billing_admin"
  | "operations_admin"
  | "admin"
  | "super_admin"
  | "owner";
export type UserStatus = "active" | "suspended" | "pending";

/** Per-user quota overrides. `null` means "inherit from plan". */
export interface QuotaOverrides {
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
}

/** Effective (resolved) quota values for a user. */
export interface EffectiveQuota {
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
}

/**
 * The card on file for an account. Only the display fields the payment provider
 * hands back — never a card number, never the provider token.
 */
export interface AdminPaymentMethod {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  plan_id: string | null;
  plan_key: string | null;
  plan_name: string | null;
  created_at: string;
  app_count: number;
  overrides: QuotaOverrides;
  /** Default card across the workspaces this user owns; null when none saved. */
  payment_method: AdminPaymentMethod | null;
  /** How many cards are on file, so "+2 more" can be shown. */
  card_count: number;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserCounts {
  apps: number;
  domains: number;
  deployments: number;
  databases: number;
}

export interface AdminUserDetail {
  user: AdminUser;
  counts: UserCounts;
  effective: EffectiveQuota;
  subscriptions: unknown[];
}

export interface UserDomainRow {
  domain: string;
  app: string;
  service: string;
}

export interface AdminOverview {
  users: { total: number; active: number; suspended: number; pending: number };
  apps: {
    total: number;
    running: number;
    stopped: number;
    failed: number;
    building: number;
    pending: number;
  };
  databases: { total: number };
  deployments: { today: number; failedToday: number; running: number };
  plans: { total: number };
  containers: { running: number };
  system: {
    cpuPercent: number;
    memUsedPercent: number;
    memUsed: string;
    memTotal: string;
    diskUsedPercent: number | null;
    uptimeSeconds: number;
    uptimeFormatted: string;
    rxSpeed: number;
    txSpeed: number;
  };
  health: "ok" | "degraded";
}

// Operations center — live operational health of the control plane. Any field
// that depends on an unavailable subsystem is null so the UI shows N/A honestly.
export interface AdminOperations {
  health: "ok" | "degraded";
  instance: {
    pid: number;
    nodeVersion: string;
    platform: string;
    uptimeSeconds: number;
    memoryRss: string;
    heapUsed: string;
    heapTotal: string;
  };
  database: { reachable: boolean; latencyMs: number | null; provider: string };
  docker: {
    cliAvailable: boolean;
    /** The socket or TCP address the backend is talking to. */
    endpoint: string;
    daemonReachable: boolean;
    version: string | null;
    runningContainers: number | null;
    message: string | null;
  };
  system: {
    cpuPercent: number;
    memUsedPercent: number;
    memUsed: string;
    memTotal: string;
    diskUsedPercent: number | null;
    diskUsed: string;
    diskTotal: string;
    uptimeSeconds: number;
    uptimeFormatted: string;
    rxSpeed: number;
    txSpeed: number;
  } | null;
  deployments: {
    today: number | null;
    failedToday: number | null;
    running: number | null;
    recent: {
      id: string;
      status: string;
      createdAt: string;
      projectId: string | null;
      projectName: string | null;
    }[];
  };
  maintenance: { enabled: boolean; reason: string };
  timestamp: string;
}

/** One row of the admin all-applications table. */
export interface AppRow {
  id: string;
  name: string;
  owner: { id: string; name: string; email: string } | null;
  project_type: string;
  source_type: string;
  build_type: string;
  status: string;
  container_status: string | null;
  running: boolean;
  domain: string | null;
  created_at: string;
  last_deployment: { status: string; created_at: string } | null;
}

export interface DeploymentRow {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  durationMs: number | null;
  trigger: string | null;
  commit_sha: string | null;
  project: { id: string; name: string };
  owner: { name: string; email: string } | null;
}

export interface DeploymentsResponse {
  deployments: DeploymentRow[];
  total: number;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: string;
  is_public: boolean;
  ram_mb: number | null;
  cpus_milli: number | null;
  storage_mb: number | null;
  max_apps: number | null;
  max_domains: number | null;
  max_backups: number | null;
  user_count: number;
}

/** Payload for creating/updating a plan (no id or user_count). */
export type PlanInput = Omit<Plan, "id" | "user_count">;

export interface AdminSettings {
  platform_name: string;
  registration_enabled: boolean;
  deployments_enabled: boolean;
  default_plan_key: string;
  maintenance_mode: boolean;
  maintenance_message: string;
  feature_flags: Record<string, boolean>;
  /** Log retention in whole days. 0 = keep forever. */
  audit_retention_days: number;
  error_retention_days: number;
  error_resolved_retention_days: number;
  /** Apex the platform owns, e.g. `godhosting.bond`. "" = feature off. */
  base_domain: string;
  /** Give every deployed service a hostname under the base domain. */
  auto_subdomain_enabled: boolean;
  /** How that hostname is built — must contain {slug} and {base}. */
  subdomain_template: string;
}

// ── Domains & DNS ────────────────────────────────────────────────────────────
// One row per hostname (a service may hold several, comma-separated).

export interface AdminDomainRow {
  hostname: string;
  service_id: string;
  service_name: string;
  project_id: string | null;
  project_name: string | null;
  owner: { id: string; name: string; email: string } | null;
  status: string;
  created_at: string;
  /** True when the hostname sits under the platform base domain. */
  managed: boolean;
  /** null when certificate state could not be read. */
  ssl: { status: string; expires_at: string | null } | null;
}

/**
 * Which reverse proxy owns the host's 80/443, and therefore how a tenant hostname
 * becomes reachable: our own nginx, an incumbent Traefik we publish through, or
 * nothing at all (host ports only).
 */
export interface AdminEdgeInfo {
  mode: "nginx" | "traefik" | "none";
  container: string | null;
  network: string | null;
  cert_resolver: string | null;
  reason: string;
}

export interface AdminDomainsResponse {
  domains: AdminDomainRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { managed: number; custom: number };
  /** Public IP the wildcard DNS record should point at; null when unknown. */
  server_ip: string | null;
  config: {
    base_domain: string;
    auto_subdomain_enabled: boolean;
    subdomain_template: string;
    /** Rendered sample, e.g. `my-app.godhosting.bond`. */
    example: string | null;
  };
  edge?: AdminEdgeInfo | null;
}

// ── Feature flags ────────────────────────────────────────────────────────────
// The definitions travel with the values: the backend owns the registry (only
// keys it actually enforces are in it), so the page never hardcodes its own copy.

export interface FeatureFlagDef {
  key: string;
  label: string;
  description: string;
  group: string;
  default: boolean;
  /** Where the server enforces it, shown so an operator can audit the claim. */
  enforcedAt: string;
}

export interface FeatureFlagsResponse {
  flags: Record<string, boolean>;
  definitions: FeatureFlagDef[];
  /** How many are switched off right now. */
  disabled: number;
  /** Only on a PATCH response: keys whose value actually moved. */
  changed?: string[];
}

export interface AuditRow {
  id: string;
  action: string;
  resource: string | null;
  ip: string | null;
  created_at: string;
  /** Actor id — null once the account is deleted, or for internal work. */
  user_id: string | null;
  user: { name: string; email: string } | null;
  metadata: unknown;
}

export interface AuditLogsResponse {
  logs: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Error Center ─────────────────────────────────────────────────────────────
// One row per *group* of identical failures, not per occurrence: `count` is how
// many times it has happened, `first_seen_at`/`last_seen_at` bracket the window.

export type ErrorLevel = "error" | "warn";

export interface ErrorGroup {
  id: string;
  fingerprint: string;
  level: ErrorLevel;
  /** api | deploy | docker | git | nginx | cert | webhook | backup | internal */
  source: string;
  message: string;
  route: string | null;
  status_code: number | null;
  request_id: string | null;
  resource: string | null;
  workspace_id: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  user: { id: string; name: string; email: string } | null;
  /** Stack trace — only returned by the single-group endpoint. */
  detail?: string | null;
}

export interface ErrorSourceStat {
  source: string;
  groups: number;
  occurrences: number;
}

export interface ErrorsResponse {
  errors: ErrorGroup[];
  page: number;
  pageSize: number;
  total: number;
  summary: {
    open: number;
    resolved: number;
    active_24h: number;
    sources: ErrorSourceStat[];
  };
}

// Re-export Project for admin sub-resource endpoints (apps/databases).
export type { Project };
