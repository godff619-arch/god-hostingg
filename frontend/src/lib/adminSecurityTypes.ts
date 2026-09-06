// Shapes returned by `/api/admin/security/*`, `/api/admin/sessions` and
// `/api/admin/api-keys` (spec §29–§31), plus the two tone maps the page needs.
//
// Kept beside `adminCommsTypes.ts` for the same reason: the page files stay about
// layout and behaviour, and the contract with the backend is readable in one place.

import type { Tone } from "@/lib/adminFormat";

export interface LoginAttemptRow {
  id: string;
  email: string;
  ip: string | null;
  user_agent?: string | null;
  outcome: string;
  success: boolean;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  ip: string | null;
  device: string | null;
  user_agent: string | null;
  suspicious: boolean;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  is_self: boolean;
}

export interface SessionsResponse {
  sessions: SessionRow[];
  total: number;
  includes_ended: boolean;
}

export interface SecurityOverview {
  totals: {
    failed_24h: number;
    failed_7d: number;
    success_24h: number;
    locked_accounts: number;
    live_sessions: number;
    suspicious_sessions: number;
    active_keys: number;
    expiring_keys: number;
    admin_accounts: number;
  };
  recent_attempts: LoginAttemptRow[];
  recent_sessions: Array<{
    id: string;
    user_id: string;
    email: string | null;
    name: string | null;
    ip: string | null;
    device: string | null;
    suspicious: boolean;
    last_seen_at: string;
  }>;
  offenders: Array<{ ip: string | null; attempts: number }>;
}

export interface AttemptsResponse {
  attempts: LoginAttemptRow[];
  total: number;
  page: number;
  page_size: number;
  outcomes: string[];
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  status: "active" | "expired" | "revoked";
}

export interface ApiKeysResponse {
  /** Header name a client sends the key in; the server owns the string. */
  header: string;
  /** Permissions the caller may grant — never more than they hold themselves. */
  grantable: string[];
  all_permissions: string[];
  keys: ApiKeyRow[];
}

/** The plaintext secret, returned exactly once by POST /api-keys. */
export interface CreatedApiKey {
  message: string;
  key: { id: string; name: string; prefix: string; secret: string };
  header: string;
}

/** Sign-in outcome → pill tone. `ok` is the only green. */
export function outcomeTone(outcome: string): Tone {
  switch (outcome) {
    case "ok":
      return "success";
    case "bad_password":
    case "unknown_user":
      return "danger";
    case "locked":
      return "warning";
    case "suspended":
    case "pending":
      return "info";
    default:
      return "neutral";
  }
}

/** Words for the outcomes. `unknown_user` must not read as "wrong password". */
export const OUTCOME_LABELS: Record<string, string> = {
  ok: "Signed in",
  bad_password: "Wrong password",
  unknown_user: "No such account",
  suspended: "Suspended",
  pending: "Awaiting approval",
  locked: "Locked out",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

/** API key lifecycle → tone. Expired and revoked are equally dead, differently caused. */
export function keyTone(status: string): Tone {
  switch (status) {
    case "active":
      return "success";
    case "expired":
      return "warning";
    case "revoked":
      return "neutral";
    default:
      return "neutral";
  }
}
