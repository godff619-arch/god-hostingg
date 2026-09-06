// Shapes returned by `backend/src/routes/adminWorkspaces.ts`. Hand-written to match
// that file's `res.json(...)` — nothing here is inferred, so a field that appears
// in the UI provably comes off the wire.

/** A member row on the workspace detail page. */
export interface WorkspaceMemberRow {
  id: string;
  email: string;
  role: string;
  /** `active` once the invited address registers; `invited` until then. */
  status: string;
  invited_at: string | null;
  joined_at: string | null;
  user: { id: string; name: string | null; email: string; status: string } | null;
}

export interface WorkspaceEnvironmentRow {
  id: string;
  name: string;
  is_default: boolean;
  resources: number;
}

export interface WorkspaceProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  resources: number;
  environments: WorkspaceEnvironmentRow[];
}

/** A deployable service or database inside one of the workspace's projects. */
export interface WorkspaceResourceRow {
  id: string;
  name: string;
  project_type: string | null;
  status: string | null;
  domain: string | null;
  created_at: string;
  workspace_project_id: string | null;
  environment_id: string | null;
}

export interface WorkspaceOwner {
  id: string;
  name: string | null;
  email: string;
  status: string;
  role: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  /** Already resolved: the workspace's own billing email, or the owner's. */
  email: string;
  /** True when `email` came from the owner because the workspace has none. */
  email_is_inherited: boolean;
  avatar: string | null;
  plan_key: string;
  /**
   * What the workspace is entitled to right now. Differs from `plan_key` when the
   * subscription has lapsed or the period ended — that gap is the thing worth
   * seeing, so both are shown rather than only the effective one.
   */
  effective_plan_key: string;
  subscription_status: string;
  payment_status: string;
  billing_provider: string | null;
  current_period_end: string | null;
  manual_override: boolean;
  owner: WorkspaceOwner;
  projects: number;
  members: number;
  resources: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspacesResponse {
  workspaces: WorkspaceRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    plans: Array<{ key: string; count: number }>;
    statuses: Array<{ key: string; count: number }>;
  };
  member_roles: string[];
}

/** NULL until the customer opens their own workspace settings. */
export interface WorkspaceSettingsSummary {
  pipeline_tier: string;
  deploy_policy: string;
  require_2fa: boolean;
  session_timeout_minutes: number | null;
  security_alerts: boolean;
  saml_enabled: boolean;
  scim_enabled: boolean;
  hipaa_enabled: boolean;
  hipaa_accepted_at: string | null;
}

export interface WorkspaceDetailResponse {
  workspace: WorkspaceRow & {
    manual_override_by: string | null;
    manual_override_reason: string | null;
    manual_override_at: string | null;
    current_period_start: string | null;
    cancel_at_period_end: boolean;
    subscription_id: string | null;
  };
  members: WorkspaceMemberRow[];
  projects: WorkspaceProjectRow[];
  resources: WorkspaceResourceRow[];
  settings: WorkspaceSettingsSummary | null;
  member_roles: string[];
}
