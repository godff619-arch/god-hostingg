// Types for the `/api/admin` communication endpoints (backend `routes/adminComms.ts`).
//
// Split out for the same reason `adminBillingTypes.ts` was: one large, self-contained
// contract read only by the three pages that speak it (Email, Announcements, Support).
//
// Three conventions carried over from the server and worth knowing here:
//   • The SMTP password is never on the wire. `SmtpConfig` has `has_password`, a
//     boolean, and a PATCH that omits `password` keeps the stored credential — so
//     the form must send the key only when the operator actually typed a new one.
//   • A send is reported as it happened. `status` is `sent | failed | queued`, and
//     `queued` means "written down, not delivered". The UI must not colour it green.
//   • `internal` on a support message means the customer never sees it. The customer
//     API filters those rows out in SQL; this type keeps the flag so the admin thread
//     can mark them visibly.

// ── §21 SMTP ─────────────────────────────────────────────────────────────────

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Implicit TLS (465). False means STARTTLS on 587/25. */
  secure: boolean;
  user: string;
  from_email: string;
  from_name: string;
  reply_to: string;
  /** Presence only — the value is unreadable from any API. */
  has_password: boolean;
  /** True when a send would actually be attempted. */
  ready: boolean;
}

export interface SmtpResponse {
  smtp: SmtpConfig;
  /** Whole-table counts, so "is mail working?" is answerable from this page. */
  queue: { queued: number; failed: number; sent: number };
  never_returned: string[];
}

/** Everything the form may change. Omitted keys are left alone by the server. */
export interface SmtpPatchBody {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
}

export interface VerifyResult {
  ok: boolean;
  error: string | null;
}

/** `POST /email/test`, `POST /email/logs/:id/retry` — the shape of one send. */
export interface SendOutcome {
  success: boolean;
  log_id: string;
  status: "sent" | "failed" | "queued";
  error: string | null;
  message: string;
}

// ── §21 templates ────────────────────────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  key: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
  /** Tokens the built-in for this key documents; empty for an operator's own row. */
  tokens: string[];
  /** True when a built-in exists, i.e. the row can be reset. */
  resettable: boolean;
}

export interface TemplatesResponse {
  templates: EmailTemplate[];
}

export interface TemplatePreview {
  subject: string;
  html: string;
  text: string;
  tokens_used: string[];
}

// ── §21 the mail log ─────────────────────────────────────────────────────────

export interface Facet {
  key: string;
  count: number;
}

export interface EmailLogRow {
  id: string;
  to_email: string;
  from_email: string | null;
  subject: string;
  template_key: string | null;
  status: string;
  error: string | null;
  kind: string;
  related_type: string | null;
  related_id: string | null;
  attempts: number;
  last_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
  /** Decided by the server: a row written before bodies were stored cannot re-send. */
  retryable: boolean;
}

export interface EmailLogsResponse {
  logs: EmailLogRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: { statuses: Facet[]; kinds: Facet[] };
}

/** The detail row adds the body — the answer to "what exactly did we send them?". */
export interface EmailLogDetail extends EmailLogRow {
  body_html: string | null;
  body_text: string | null;
  user_id: string | null;
}

export interface EmailLogResponse {
  log: EmailLogDetail;
  user: { id: string; name: string | null; email: string } | null;
}

export interface DrainResult {
  success: boolean;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

// ── §22 announcements ────────────────────────────────────────────────────────

export interface PlanFacet {
  key: string;
  name: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  level: string;
  audience: string;
  /** Normalised to a string list by the server, whatever the JSON column holds. */
  audience_ref: string[];
  placement: string;
  published: boolean;
  send_email: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  /** Derived server-side, so every surface agrees on what "live" means (§61). */
  live?: boolean;
}

export interface AnnouncementsResponse {
  announcements: Announcement[];
  total: number;
  page: number;
  pageSize: number;
  levels: readonly string[];
  audiences: readonly string[];
  placements: readonly string[];
  plans: PlanFacet[];
}

export interface AnnouncementDetail {
  announcement: Announcement;
  /** A sample, not the list — an audience of "all" is a count, not something to render. */
  audience: {
    size: number;
    sample: Array<{ id: string; name: string; email: string }>;
  };
  delivered: { inbox: number; email: number };
}

export interface DeliverResult {
  success: boolean;
  audience_size: number;
  notified: number;
  already_notified: number;
  queued_emails: number;
  sent_now: number;
  message: string;
}

// ── §23 support ──────────────────────────────────────────────────────────────

export interface TicketParty {
  id: string;
  name: string;
  email: string;
  status?: string;
}

export interface SupportTicketRow {
  id: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  message_count: number;
  workspace: { id: string; name: string } | null;
  requester: TicketParty | null;
  assignee: TicketParty | null;
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
}

export interface SupportTicketsResponse {
  tickets: SupportTicketRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: { statuses: Facet[]; priorities: Facet[] };
  /** Open/pending/in-progress with nobody on them — the number that needs action. */
  unassigned: number;
  statuses: readonly string[];
  priorities: readonly string[];
  categories: readonly string[];
}

export interface SupportAgent {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface SupportMessage {
  id: string;
  /** `user` | `admin` | `system`. */
  author: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  /** True ⇒ a note the customer never sees. */
  internal: boolean;
  created_at: string;
}

export interface SupportTicketDetail {
  ticket: SupportTicketRow & {
    workspace: { id: string; name: string; plan_key: string } | null;
  };
  messages: SupportMessage[];
  statuses: readonly string[];
  priorities: readonly string[];
  categories: readonly string[];
}

export interface ReplyResult {
  success: boolean;
  message: SupportMessage;
  /** null when nothing was mailed (an internal note, or no requester on file). */
  mail: { status: string; message: string } | null;
  status: string;
}

// ── shared display helpers ───────────────────────────────────────────────────

/**
 * Tone for a delivery status. Deliberately not merged into `adminFormat`'s billing
 * table: `queued` is a *warning* here (nothing has left the building yet), while the
 * same word on an invoice would mean something else entirely.
 */
export function mailTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  if (status === "queued") return "warning";
  return "neutral";
}

/** Tone for a ticket status. `open` reads as needing attention, not as healthy. */
export function ticketTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "open") return "warning";
  if (status === "in_progress") return "info";
  if (status === "pending") return "neutral";
  if (status === "resolved") return "success";
  if (status === "closed") return "neutral";
  return "neutral";
}

export function priorityTone(priority: string): "neutral" | "warning" | "danger" | "info" {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warning";
  if (priority === "low") return "neutral";
  return "info";
}

export function announcementTone(level: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (level === "critical") return "danger";
  if (level === "warning") return "warning";
  if (level === "success") return "success";
  return "info";
}
