// Types for the workspace layer (User → Workspace → Project → Environment →
// Resource). Mirrors the `/api/workspace`, `/api/billing` and `/api/integrations`
// contracts. Nothing here is hardcoded per-account — every value comes from the
// logged-in user's real workspace.

export type PlanTier = "hobby" | "pro" | "scale";

export type FeatureKey =
  | "webhooks"
  | "dedicated_ips"
  | "security"
  | "audit_logs"
  | "authentication"
  | "hipaa"
  | "build_pipeline_performance";

export type WorkspaceRole = "owner" | "admin" | "developer" | "viewer";

export interface PlanRef {
  key: PlanTier;
  label: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  /** First letter of the workspace name — the header avatar glyph. */
  initial: string;
  created_at: string;
  plan: PlanRef;
  features: Record<FeatureKey, boolean>;
  role: WorkspaceRole;
}

export interface WorkspaceContextPayload {
  workspace: WorkspaceSummary;
  owner: { name: string; email: string } | null;
  counts: { projects: number; resources: number; members: number };
}

/** A row in the header's workspace switcher (`GET /api/workspace/list`). */
export interface WorkspaceListItem {
  id: string;
  name: string;
  initial: string;
  avatar: string | null;
  plan: PlanRef;
  role: WorkspaceRole;
  is_owner: boolean;
}

/** Aggregated card health. `empty` = a brand-new project with no resources. */
export type ProjectHealth = "healthy" | "warning" | "error" | "deploying" | "empty";

export interface ProjectCard {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** Newest deployment across every resource in the project; null if never deployed. */
  last_deployed_at: string | null;
  counts: { resources: number; services: number; databases: number; environments: number };
  /** Measured per-state resource counts. Drives the deploy summary and filters. */
  states: Record<ResourceState, number>;
  health: ProjectHealth;
}

export type ResourceState =
  | "deployed"
  | "deploying"
  | "building"
  | "failed"
  | "suspended"
  | "pending";

export interface ResourceRow {
  id: string;
  environment_id: string | null;
  name: string;
  type: "service" | "database";
  state: ResourceState;
  runtime: string;
  /** NULL when the platform has no configured region — render "—", never a fake. */
  region: string | null;
  domain: string | null;
  service_count: number;
  updated_at: string | null;
  last_deploy: { status: string | null; created_at: string | null; finished_at: string | null } | null;
}

export interface EnvironmentRow {
  id: string;
  name: string;
  is_default: boolean;
  counts: { all: number; services: number; databases: number; env_groups: number };
}

export interface ProjectOverviewPayload {
  project: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  };
  workspace: { id: string; name: string };
  environments: EnvironmentRow[];
  resources: ResourceRow[];
}

export interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  status: string;
  is_owner: boolean;
  invited_at: string;
  joined_at: string | null;
}

// ------------------------------------------------------------------ billing

export interface PlanOption {
  key: PlanTier;
  name: string;
  price_cents: number;
  blurb: string;
  benefits: string[];
}

/**
 * Card on file — §6 shape.
 *
 * The API sends brand + last four and nothing else that could reconstruct a card.
 * There is no `number` and no `cvv` field here because the server never stores one;
 * `label` is the ready-made `Visa •••• 7411` string so no component re-invents the
 * masking and accidentally prints more than four digits.
 */
export interface PaymentMethodRow {
  id: string;
  provider: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
  status: string;
  type: string;
  funding: string;
  billing_name: string | null;
  billing_country: string | null;
  created_at: string;
  label: string;
  expiry_label: string;
}

/**
 * §37 billing state. Five separate fields, because a single `plan` column cannot
 * express "bought Pro, payment failed, period already over".
 *
 * `plan_key` is what was purchased; `effective_plan` is what the workspace is
 * entitled to *right now* (a lapsed Pro reads `pro` / `hobby`). Feature gating on
 * the client should read `effective_plan`; `live` is the one-boolean summary.
 */
export interface SubscriptionState {
  plan_key: string;
  plan_label: string;
  effective_plan: string;
  effective_plan_label: string;
  subscription_status: string;
  payment_status: string;
  billing_provider: string | null;
  subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  live: boolean;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: string | null;
}

/** A checkout session. Never carries a secret key — publishable ids only. */
export interface CheckoutSessionView {
  id: string;
  plan_key: string;
  amount_cents: number;
  amount_label: string;
  currency: string;
  provider: string;
  provider_ref: string | null;
  redirect_url: string | null;
  status: string;
  payment_id: string | null;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
  instructions: string | null;
  publishable_key: string | null;
}

export interface CheckoutStatus {
  checkout: CheckoutSessionView;
  payment: {
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    failure_code: string | null;
    failure_message: string | null;
    succeeded_at: string | null;
  } | null;
  subscription: SubscriptionState;
}

/** How this instance takes money, plus any checkout already in flight. */
export interface CheckoutConfig {
  provider: string;
  currency: string;
  stripe_publishable_key: string | null;
  razorpay_key_id: string | null;
  manual_instructions: string | null;
  pending_session: {
    id: string;
    plan_key: string;
    amount_cents: number;
    currency: string;
    redirect_url: string | null;
    provider_ref: string | null;
    expires_at: string;
  } | null;
}

export interface BillingProfile {
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  vat_id: string | null;
}

/**
 * One included-usage meter. `limit: null` means unlimited on this plan, and
 * `percent` is then null too — the UI shows "Unlimited" instead of a bar.
 */
export interface UsageMeter {
  used: number;
  limit: number | null;
  percent: number | null;
  unit: string;
}

export interface BandwidthMeter extends UsageMeter {
  breakdown: {
    http_response: number;
    service_initiated: number;
    websocket: number;
    private_link: number;
  };
}

export interface UnbilledGroup {
  resource: string;
  resource_type: string;
  unit: string;
  quantity: number;
  cents: number;
}

export type InvoiceStatus = "paid" | "pending" | "failed" | "refunded";

export interface InvoiceRow {
  id: string;
  /** Human-facing sequential number, `GH-2026-0001`. */
  number?: string | null;
  period_start: string;
  period_end: string;
  amount_cents: number;
  currency: string;
  status: InvoiceStatus | string;
  has_pdf: boolean;
  issued_at: string;
  paid_at?: string | null;
}

export interface BillingPayload {
  workspace: { id: string; name: string; plan: PlanRef };
  /** Billing period key, `YYYY-MM`. */
  period: string;
  plans: PlanOption[];
  /** §37 state. `workspace.plan` is the effective tier; this says why. */
  subscription: SubscriptionState;
  checkout: CheckoutConfig;
  payment_methods: PaymentMethodRow[];
  billing_profile: BillingProfile | null;
  included_usage: {
    instance_hours: UsageMeter;
    custom_domains: UsageMeter;
    services: UsageMeter;
    bandwidth: BandwidthMeter;
    pipeline_minutes: UsageMeter;
  };
  unbilled: { total_cents: number; projected_cents: number; groups: UnbilledGroup[] };
  credit: { balance_cents: number };
  invoices: InvoiceRow[];
}

// ------------------------------------------------------------- integrations

export interface WebhookDelivery {
  id: string;
  event: string;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  attempted_at: string;
}

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  delivery_count: number;
  /** Presence only — the signing secret is never returned after creation. */
  secret_configured: boolean;
  recent_deliveries: WebhookDelivery[];
}

export interface WebhooksPayload {
  plan: PlanRef;
  unlocked: boolean;
  required_plan: PlanTier;
  available_events: string[];
  webhooks: WebhookRow[];
}

export interface ObservabilityStream {
  id: string;
  kind: "metrics" | "logs";
  provider: string;
  endpoint: string | null;
  enabled: boolean;
  include_preview: boolean;
  secret_configured: boolean;
  last_test: string | null;
  last_test_at: string | null;
}

export interface ObservabilityPayload {
  providers: string[];
  metrics: ObservabilityStream | null;
  logs: ObservabilityStream | null;
}

export interface DedicatedIpRow {
  id: string;
  address: string;
  region: string | null;
  status: string;
  created_at: string;
  assigned_services: string[];
}

export interface DedicatedIpsPayload {
  plan: PlanRef;
  unlocked: boolean;
  required_plan: PlanTier;
  ips: DedicatedIpRow[];
}

export interface RegistryCredentialRow {
  id: string;
  name: string;
  provider: string;
  registry_host: string | null;
  username: string;
  secret_configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface RegistryCredentialsPayload {
  providers: string[];
  credentials: RegistryCredentialRow[];
}

// ---------------------------------------------------------- environment groups

/**
 * One variable in an environment group. `value` is `null` exactly when
 * `is_secret` is true — the API never returns a secret's plaintext, so the
 * editor keeps the stored value by sending the row's `id` back unchanged.
 */
export interface EnvGroupVar {
  id: string;
  key: string;
  value: string | null;
  is_secret: boolean;
  updated_at: string | null;
}

/** An environment the group is linked to, named for display. */
export interface EnvGroupLink {
  id: string;
  environment_id: string;
  environment_name: string;
  project_id: string;
  project_name: string;
}

export interface EnvGroupRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  var_count: number;
  secret_count: number;
  vars: EnvGroupVar[];
  links: EnvGroupLink[];
}

/** Every environment in the workspace, grouped by project — the link picker. */
export interface EnvGroupTarget {
  project_id: string;
  project_name: string;
  environments: Array<{ id: string; name: string }>;
}

export interface EnvGroupsPayload {
  workspace: { id: string; name: string };
  role: WorkspaceRole;
  /** False for viewers; mirrors the server's own write guard. */
  can_write: boolean;
  groups: EnvGroupRow[];
  targets: EnvGroupTarget[];
}

// ---------------------------------------------------------------- notifications

export type NotificationEvent =
  | "deploy.succeeded"
  | "deploy.failed"
  | "service.suspended"
  | "quota.exceeded"
  | "billing"
  | "system";

/** all = every state change, failure = only problems, none = silence the lifecycle. */
export type NotificationLevel = "all" | "failure" | "none";

export type NotificationSeverity = "info" | "warning" | "error";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  severity: NotificationSeverity;
  resource: string | null;
  /** In-app path to open. NULL when the subject no longer has a page. */
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * A delivery destination. The URL is a credential (a Slack webhook URL is all
 * you need to post), so only its host comes back as `hint`.
 */
export interface NotificationChannelRow {
  id: string;
  kind: "slack" | "webhook";
  name: string;
  hint: string;
  enabled: boolean;
  last_result: "ok" | "failed" | null;
  last_sent_at: string | null;
  created_at: string;
}

export interface NotificationSettingsRow {
  default_level: NotificationLevel;
  include_preview: boolean;
  events: NotificationEvent[];
  /** False while the platform defaults are still in force. */
  saved: boolean;
}

export interface NotificationsPayload {
  workspace: { id: string; name: string };
  available_events: NotificationEvent[];
  channel_kinds: Array<"slack" | "webhook">;
  settings: NotificationSettingsRow;
  channels: NotificationChannelRow[];
  total: number;
  unread: number;
  page: number;
  page_size: number;
  notifications: NotificationRow[];
}

// ------------------------------------------------------------- private links

/** A project that may sit on either end of a private link. */
export interface PrivateLinkCandidate {
  id: string;
  name: string;
  kind: "app" | "database";
  /** Managed-DB engine id when `kind` is "database". */
  engine: string | null;
  status: string | null;
  /**
   * Container DNS name the target answers on. NULL until the project has been
   * deployed once — the UI says "not deployed yet" rather than inventing a host.
   */
  container: string | null;
  /** Port the server suggests; the form may override it. NULL when unknown. */
  suggested_port: number | null;
}

export interface PrivateLinkRow {
  id: string;
  name: string;
  source: { id: string; name: string };
  target: { id: string; name: string };
  target_port: number;
  scheme: "http" | "tcp";
  /** Env var injected on the source. NULL = the link injects nothing. */
  env_key: string | null;
  /** Result of the last apply: active | pending | error. Never assumed. */
  status: string;
  /** Docker's own reason when the last apply failed. */
  last_error: string | null;
  last_applied_at: string | null;
  created_at: string;
  /** Internal address, or NULL while the target has no container. */
  address: string | null;
}

export interface PrivateLinksPayload {
  workspace: { id: string; name: string };
  can_write: boolean;
  links: PrivateLinkRow[];
  candidates: PrivateLinkCandidate[];
  schemes: Array<"http" | "tcp">;
  /** Every link stays pending while the daemon is unreachable, so we say so. */
  docker: { reachable: boolean; message: string | null };
}

// -------------------------------------------------------------- blueprints

export type BlueprintServiceType = "web" | "private" | "worker";
export type BlueprintSpecFormat = "yaml" | "json";

/** One service the spec declares, as the server parsed it. */
export interface BlueprintSpecServiceSummary {
  name: string;
  type: BlueprintServiceType;
  repo: string;
  branch: string | null;
  port: number;
  env_count: number;
}

export interface BlueprintSpecDatabaseSummary {
  name: string;
  engine: string;
  version: string | null;
}

/**
 * A recorded apply. Immutable history: `partial` means some items were created
 * and others failed, and is never reported as a success.
 */
export interface BlueprintApplyRow {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  created_count: number;
  skipped_count: number;
  failed_count: number;
  log: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  workspace_project_id: string | null;
  environment_id: string | null;
}

export interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  /** manual = written here. repo = synced from a file in a repository. */
  source: string;
  repo_url: string | null;
  repo_branch: string | null;
  spec_path: string | null;
  spec: string;
  spec_format: BlueprintSpecFormat;
  last_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string | null;
  summary: {
    services: BlueprintSpecServiceSummary[];
    databases: BlueprintSpecDatabaseSummary[];
    /** Non-empty means an apply would refuse to run. */
    errors: string[];
  };
  applies: BlueprintApplyRow[];
}

/** Where an apply can create resources — never guessed by the client. */
export interface BlueprintTarget {
  project_id: string;
  project_name: string;
  environments: Array<{ id: string; name: string }>;
}

export interface BlueprintsPayload {
  workspace: { id: string; name: string };
  role: WorkspaceRole;
  can_write: boolean;
  blueprints: BlueprintRow[];
  targets: BlueprintTarget[];
  service_types: BlueprintServiceType[];
  spec_formats: BlueprintSpecFormat[];
  engines: Array<{ id: string; label: string }>;
  example_spec: string;
}

/**
 * POST /api/blueprints/validate — parse without saving. The services here are
 * the fully parsed spec entries, not the list summary, so `envVars` is the real
 * array rather than a count.
 */
export interface BlueprintValidation {
  ok: boolean;
  errors: string[];
  services: Array<{
    name: string;
    type: BlueprintServiceType;
    repo: string;
    branch: string | null;
    port: number;
    envVars: Array<{ key: string; value: string }>;
  }>;
  databases: BlueprintSpecDatabaseSummary[];
}

// -------------------------------------------------------- workspace settings

/**
 * A build-pipeline tier as the server defines it. Rates are integer cents per
 * 1,000 minutes and `requires` names the feature that unlocks the tier, so the
 * page never hardcodes either the price or the gate.
 */
export interface PipelineTier {
  key: string;
  name: string;
  rate_cents_per_1000_min: number;
  cpu: number;
  memory_gb: number;
  free_minutes: number;
  requires: FeatureKey | null;
}

export interface ComplianceDocument {
  key: string;
  name: string;
  description: string;
}

/**
 * The stored settings row. NULL keeps its meaning throughout: no spend cap, no
 * session timeout, no IP restriction, no IdP configured.
 */
export interface WorkspaceSettingsRow {
  pipeline_tier: string;
  pipeline_spend_limit_cents: number | null;
  deploy_policy: "override" | "wait";
  require_2fa: boolean;
  session_timeout_minutes: number | null;
  /** Newline-separated CIDRs. NULL = no restriction. */
  ip_allowlist: string | null;
  security_alerts: boolean;
  saml_enabled: boolean;
  saml_metadata_url: string | null;
  scim_enabled: boolean;
  hipaa_enabled: boolean;
  hipaa_accepted_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceSettingsPayload {
  workspace: {
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
    initial: string;
    created_at: string;
  };
  plan: PlanRef;
  features: Record<FeatureKey, boolean>;
  /** Feature → minimum tier, so an upgrade card can name the right plan. */
  feature_tiers: Record<FeatureKey, PlanTier>;
  role: WorkspaceRole;
  can_delete: boolean;
  /** Why deletion is refused, straight from the server's own guards. */
  delete_block: "not_owner" | "not_empty" | "last_workspace" | null;
  resource_count: number;
  member_count: number;
  pipeline_tiers: PipelineTier[];
  documents: ComplianceDocument[];
  settings: WorkspaceSettingsRow;
}

/** Audit rows are immutable; `result` is derived from the action, never stored. */
export interface AuditLogRow {
  id: string;
  created_at: string;
  user: { id: string; name: string | null; email: string } | null;
  action: string;
  resource: string | null;
  ip: string | null;
  result: "success" | "failure";
}

export interface AuditLogsPayload {
  plan: PlanRef;
  unlocked: boolean;
  required_plan: PlanTier;
  total: number;
  page: number;
  page_size: number;
  /** Distinct actions present in this workspace's log, for the filter dropdown. */
  actions: string[];
  logs: AuditLogRow[];
}
