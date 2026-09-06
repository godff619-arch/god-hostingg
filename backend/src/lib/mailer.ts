// Outbound email: SMTP configuration, template rendering and delivery (§21).
//
// Three rules shape this file.
//
// The password is sealed with `secretBox` and never leaves the server. Every read
// path returns `has_password` — a boolean — so the Admin → Email page can show that
// a credential exists without ever being able to display it, and a PATCH that omits
// the field keeps the stored one rather than blanking it. SMTP failures are recorded
// with the credential scrubbed out of the transport's own error string.
//
// Delivery is recorded as it happened, never as intended. A mail with no transport
// configured stays `queued` (its rendered body is stored, so it can go out later);
// an attempt that failed is `failed` with the reason; only a message the transport
// accepted becomes `sent`. Nothing here reports success it did not observe.
//
// Templates are stored rows, editable by an operator, with the built-ins below used
// only to seed a missing key. Tokens are substituted with HTML escaping by default,
// so a customer's own name cannot inject markup into a mail we send about them.

import nodemailer, { type Transporter } from 'nodemailer';
import prisma from './prisma.js';
import { open, seal } from './secretBox.js';
import { getSetting, setSetting } from './settings.js';

/** What the API may show. There is deliberately no `password` field. */
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

const KEYS = {
  enabled: 'smtp.enabled',
  host: 'smtp.host',
  port: 'smtp.port',
  secure: 'smtp.secure',
  user: 'smtp.user',
  password: 'smtp.password',
  fromEmail: 'smtp.from_email',
  fromName: 'smtp.from_name',
  replyTo: 'smtp.reply_to',
} as const;

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Read the stored configuration. Safe to return to a client as-is. */
export async function readSmtpConfig(): Promise<SmtpConfig> {
  const [enabled, host, port, secure, user, password, fromEmail, fromName, replyTo] =
    await Promise.all([
      getSetting(KEYS.enabled),
      getSetting(KEYS.host),
      getSetting(KEYS.port),
      getSetting(KEYS.secure),
      getSetting(KEYS.user),
      getSetting(KEYS.password),
      getSetting(KEYS.fromEmail),
      getSetting(KEYS.fromName),
      getSetting(KEYS.replyTo),
    ]);

  const cfg: SmtpConfig = {
    enabled: enabled === 'true',
    host: host ?? '',
    port: Number(port) > 0 ? Number(port) : 587,
    secure: secure === 'true',
    user: user ?? '',
    from_email: fromEmail ?? '',
    from_name: fromName ?? 'God Hosting',
    reply_to: replyTo ?? '',
    has_password: Boolean(password),
    ready: false,
  };
  // "Ready" is the question every caller actually asks: would a send be attempted?
  // An enabled config with no host or no sender address would only produce failures.
  cfg.ready = cfg.enabled && cfg.host.length > 0 && EMAIL_RE.test(cfg.from_email);
  return cfg;
}

export interface SmtpPatch {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  /** Omit to keep the stored one; empty string to remove it. */
  password?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
}

/**
 * Apply a patch. Returns the field that failed validation, or null.
 *
 * `password` is the only asymmetric field: absent means "leave it alone", because a
 * settings form that cannot display the current value would otherwise wipe it on
 * every save.
 */
export async function writeSmtpConfig(patch: SmtpPatch): Promise<string | null> {
  if (patch.host !== undefined && patch.host.length > 200) return 'host';
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    return 'port';
  }
  if (patch.from_email !== undefined && patch.from_email !== '' && !EMAIL_RE.test(patch.from_email)) {
    return 'from_email';
  }
  if (patch.reply_to !== undefined && patch.reply_to !== '' && !EMAIL_RE.test(patch.reply_to)) {
    return 'reply_to';
  }
  // Enabling a transport that cannot possibly deliver is refused here rather than
  // discovered as a queue full of failures.
  if (patch.enabled === true) {
    const current = await readSmtpConfig();
    const host = patch.host ?? current.host;
    const from = patch.from_email ?? current.from_email;
    if (!host) return 'host';
    if (!EMAIL_RE.test(from)) return 'from_email';
  }

  const writes: Array<Promise<void>> = [];
  if (patch.enabled !== undefined) writes.push(setSetting(KEYS.enabled, patch.enabled ? 'true' : 'false'));
  if (patch.host !== undefined) writes.push(setSetting(KEYS.host, patch.host.trim()));
  if (patch.port !== undefined) writes.push(setSetting(KEYS.port, String(patch.port)));
  if (patch.secure !== undefined) writes.push(setSetting(KEYS.secure, patch.secure ? 'true' : 'false'));
  if (patch.user !== undefined) writes.push(setSetting(KEYS.user, patch.user.trim()));
  if (patch.from_email !== undefined) writes.push(setSetting(KEYS.fromEmail, patch.from_email.trim()));
  if (patch.from_name !== undefined) writes.push(setSetting(KEYS.fromName, patch.from_name.trim()));
  if (patch.reply_to !== undefined) writes.push(setSetting(KEYS.replyTo, patch.reply_to.trim()));
  if (patch.password !== undefined) {
    writes.push(setSetting(KEYS.password, patch.password ? seal(patch.password) : ''));
  }
  await Promise.all(writes);
  transport = null; // the next send rebuilds it against the new settings
  return null;
}

// One transport, rebuilt whenever the settings change. Nodemailer pools the
// connection, so recreating it per mail would reconnect on every send.
let transport: Transporter | null = null;

async function getTransport(): Promise<Transporter | null> {
  if (transport) return transport;
  const cfg = await readSmtpConfig();
  if (!cfg.ready) return null;
  const sealed = await getSetting(KEYS.password);
  const password = open(sealed);
  transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // A username with no password is a valid anonymous relay setup, so auth is
    // only attached when there is something to authenticate with.
    auth: cfg.user && password ? { user: cfg.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/**
 * Scrub anything secret out of a transport error before it is stored or logged.
 * Nodemailer includes the failing command in some errors, and a rejected AUTH
 * command contains the base64 credential.
 */
function safeError(err: unknown, secrets: string[]): string {
  let text = err instanceof Error ? err.message : String(err);
  text = text.replace(/AUTH\s+\S+\s+\S+/gi, 'AUTH [redacted]');
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join('[redacted]');
    text = text.split(Buffer.from(secret).toString('base64')).join('[redacted]');
  }
  return text.slice(0, 500);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * `{{token}}` is substituted and HTML-escaped; `{{&token}}` is inserted raw, for
 * the few places the platform itself builds markup (an invoice line table).
 * An unknown token renders empty rather than leaving `{{token}}` in a customer's
 * inbox.
 */
export function renderTokens(body: string, tokens: Record<string, string>): string {
  return body.replace(/\{\{(&?)\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, raw: string, key: string) => {
    const value = tokens[key] ?? '';
    return raw === '&' ? value : escapeHtml(value);
  });
}

/** Crude HTML → text, for the plaintext alternative when a template has none. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The shell every built-in template renders inside. Inline styles and a table-free
 * single column, because mail clients support neither stylesheets nor modern layout
 * — and flat, for the same reason the panel is (§28).
 */
function shell(inner: string): string {
  return [
    '<div style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e6ea;border-radius:16px;padding:28px;">',
    '<p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">{{platform_name}}</p>',
    inner,
    '<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e4e6ea;font-size:12px;color:#6b7280;">',
    'Sent by {{platform_name}}. If you did not expect this, reply and tell us.',
    '</p>',
    '</div></div>',
  ].join('');
}

const H1 = 'margin:0 0 12px;font-size:20px;font-weight:700;';
const P = 'margin:0 0 12px;font-size:14px;line-height:1.6;';
const BTN =
  'display:inline-block;margin:8px 0 4px;padding:11px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;';

export interface TemplateSeed {
  key: string;
  name: string;
  subject: string;
  body_html: string;
  /** Documented for the editor, so an operator knows what they may reference. */
  tokens: string[];
}

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    key: 'welcome',
    name: 'Welcome',
    subject: 'Welcome to {{platform_name}}',
    tokens: ['platform_name', 'name', 'email', 'app_url'],
    body_html: shell(
      `<h1 style="${H1}">Welcome, {{name}}.</h1>` +
        `<p style="${P}">Your account is ready. Deploy from a Git repository or a ZIP upload, and the platform builds and runs it for you.</p>` +
        `<a href="{{app_url}}" style="${BTN}">Open the dashboard</a>`,
    ),
  },
  {
    key: 'verify_email',
    name: 'Verify your email',
    subject: 'Confirm your email address',
    tokens: ['platform_name', 'name', 'verify_url', 'expires_in'],
    body_html: shell(
      `<h1 style="${H1}">Confirm your address</h1>` +
        `<p style="${P}">Hello {{name}} — click below to confirm this address belongs to you. The link expires in {{expires_in}}.</p>` +
        `<a href="{{verify_url}}" style="${BTN}">Confirm my email</a>`,
    ),
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    subject: 'Reset your password',
    tokens: ['platform_name', 'name', 'reset_url', 'expires_in', 'ip'],
    body_html: shell(
      `<h1 style="${H1}">Reset your password</h1>` +
        `<p style="${P}">A reset was requested for {{name}} from {{ip}}. The link expires in {{expires_in}}. If this was not you, ignore this mail — nothing has changed.</p>` +
        `<a href="{{reset_url}}" style="${BTN}">Choose a new password</a>`,
    ),
  },
  {
    key: 'invoice',
    name: 'Invoice',
    subject: 'Invoice {{invoice_number}} — {{amount}}',
    tokens: ['platform_name', 'invoice_number', 'amount', 'status', 'period', 'due', 'items_html', 'app_url'],
    body_html: shell(
      `<h1 style="${H1}">Invoice {{invoice_number}}</h1>` +
        `<p style="${P}">{{period}} · <strong>{{amount}}</strong> · {{status}}{{due}}</p>` +
        `<div style="margin:16px 0;font-size:13px;">{{&items_html}}</div>` +
        `<a href="{{app_url}}" style="${BTN}">View it in your account</a>`,
    ),
  },
  {
    key: 'payment_failed',
    name: 'Payment failed',
    subject: 'We could not take your payment',
    tokens: ['platform_name', 'name', 'amount', 'reason', 'app_url'],
    body_html: shell(
      `<h1 style="${H1}">That payment did not go through</h1>` +
        `<p style="${P}">We tried to charge {{amount}} and the provider refused it: {{reason}}. Your apps keep running for now — update the card to avoid losing the plan.</p>` +
        `<a href="{{app_url}}" style="${BTN}">Update payment method</a>`,
    ),
  },
  {
    key: 'announcement',
    name: 'Announcement',
    subject: '{{title}}',
    tokens: ['platform_name', 'title', 'body_html', 'app_url'],
    body_html: shell(
      `<h1 style="${H1}">{{title}}</h1>` + `<div style="${P}">{{&body_html}}</div>`,
    ),
  },
  {
    key: 'support_reply',
    name: 'Support reply',
    subject: 'Re: {{ticket_subject}} [{{ticket_id}}]',
    tokens: ['platform_name', 'ticket_id', 'ticket_subject', 'reply_html', 'app_url'],
    body_html: shell(
      `<h1 style="${H1}">{{ticket_subject}}</h1>` +
        `<div style="${P}">{{&reply_html}}</div>` +
        `<p style="${P}">Reply to this mail to continue the conversation on ticket {{ticket_id}}.</p>`,
    ),
  },
];

/**
 * Create any built-in template that does not exist yet. Existing rows are left
 * alone — an operator's edit is not overwritten by a redeploy.
 */
export async function seedEmailTemplates(): Promise<void> {
  for (const seed of DEFAULT_TEMPLATES) {
    const existing = await prisma.emailTemplate.findUnique({ where: { key: seed.key } });
    if (existing) continue;
    await prisma.emailTemplate.create({
      data: {
        key: seed.key,
        name: seed.name,
        subject: seed.subject,
        body_html: seed.body_html,
        body_text: htmlToText(seed.body_html),
      },
    });
  }
}

/** Tokens available to every template, whatever it is about. */
async function baseTokens(): Promise<Record<string, string>> {
  const [name, url] = await Promise.all([
    getSetting('platform.name'),
    getSetting('platform.app_url'),
  ]);
  return { platform_name: name || 'God Hosting', app_url: url || '' };
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render a stored template. Falls back to the built-in for that key, so a deleted
 * row degrades to the default rather than to a blank mail. Returns null for a key
 * that has neither, and for a template an operator has switched off — a disabled
 * template means "do not send this kind of mail", and silently sending the default
 * instead would defeat the switch.
 */
export async function renderTemplate(
  key: string,
  tokens: Record<string, string>,
): Promise<RenderedMail | null> {
  const row = await prisma.emailTemplate.findUnique({ where: { key } });
  if (row && !row.enabled) return null;
  const seed = DEFAULT_TEMPLATES.find((t) => t.key === key);
  const subject = row?.subject ?? seed?.subject;
  const html = row?.body_html ?? seed?.body_html;
  if (!subject || !html) return null;

  const all = { ...(await baseTokens()), ...tokens };
  const renderedHtml = renderTokens(html, all);
  const text = row?.body_text
    ? renderTokens(row.body_text, all)
    : htmlToText(renderedHtml);
  return { subject: renderTokens(subject, all), html: renderedHtml, text };
}

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template_key?: string | null;
  /** system | admin_test | announcement | transactional */
  kind?: string;
  user_id?: string | null;
  related_type?: string | null;
  related_id?: string | null;
}

export interface SendResult {
  /** The `email_logs` row id — always written, whatever happened. */
  log_id: string;
  status: 'sent' | 'failed' | 'queued';
  error: string | null;
  message: string;
}

/**
 * Record the mail, then try to deliver it. Never throws for a delivery problem:
 * callers are usually mid-request doing something else (issuing an invoice, closing
 * a ticket) and a dead mail server must not fail that operation.
 */
export async function sendMail(input: SendInput): Promise<SendResult> {
  const cfg = await readSmtpConfig();
  const text = input.text || htmlToText(input.html);
  const log = await prisma.emailLog.create({
    data: {
      to_email: input.to,
      from_email: cfg.from_email || null,
      subject: input.subject,
      template_key: input.template_key ?? null,
      status: 'queued',
      user_id: input.user_id ?? null,
      kind: input.kind ?? 'transactional',
      body_html: input.html,
      body_text: text,
      related_type: input.related_type ?? null,
      related_id: input.related_id ?? null,
    },
  });

  if (!EMAIL_RE.test(input.to)) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: 'failed', error: 'Not a valid email address.', last_attempt_at: new Date() },
    });
    return { log_id: log.id, status: 'failed', error: 'Not a valid email address.', message: `${input.to} is not a valid address.` };
  }

  const outcome = await deliver(log.id, {
    to: input.to,
    subject: input.subject,
    html: input.html,
    text,
  });
  return { log_id: log.id, ...outcome };
}

interface Deliverable {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The single place a message meets the network. Updates the log row to whatever
 * actually happened and returns the same verdict to the caller.
 */
async function deliver(
  logId: string,
  mail: Deliverable,
): Promise<{ status: 'sent' | 'failed' | 'queued'; error: string | null; message: string }> {
  const cfg = await readSmtpConfig();
  if (!cfg.ready) {
    return {
      status: 'queued',
      error: null,
      message: 'Stored and waiting: SMTP is not configured, so nothing was sent yet.',
    };
  }

  const tx = await getTransport();
  if (!tx) {
    return { status: 'queued', error: null, message: 'Stored and waiting: no usable SMTP transport.' };
  }

  const from = cfg.from_name ? `"${cfg.from_name.replace(/"/g, '')}" <${cfg.from_email}>` : cfg.from_email;
  try {
    const info = await tx.sendMail({
      from,
      to: mail.to,
      replyTo: cfg.reply_to || undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    await prisma.emailLog.update({
      where: { id: logId },
      data: {
        status: 'sent',
        message_id: info.messageId ?? null,
        sent_at: new Date(),
        error: null,
        attempts: { increment: 1 },
        last_attempt_at: new Date(),
      },
    });
    return { status: 'sent', error: null, message: `Sent to ${mail.to}.` };
  } catch (err) {
    const sealed = await getSetting(KEYS.password);
    const error = safeError(err, [open(sealed) ?? '', cfg.user]);
    // Logged without the credential, per the standing rule that secrets never
    // reach a log line.
    console.error('[mailer] send failed:', error);
    await prisma.emailLog.update({
      where: { id: logId },
      data: { status: 'failed', error, attempts: { increment: 1 }, last_attempt_at: new Date() },
    });
    return { status: 'failed', error, message: `The mail server refused it: ${error}` };
  }
}

/**
 * Retry one stored mail. Only rows whose body was kept can be retried; an older
 * `queued` row written before bodies were stored has nothing to send, and is
 * reported as such instead of being silently marked sent.
 */
export async function retryEmail(logId: string): Promise<SendResult> {
  const log = await prisma.emailLog.findUnique({ where: { id: logId } });
  if (!log) return { log_id: logId, status: 'failed', error: 'No such mail.', message: 'No such mail.' };
  if (log.status === 'sent') {
    return { log_id: logId, status: 'sent', error: null, message: 'Already sent — nothing to retry.' };
  }
  if (!log.body_html) {
    return {
      log_id: logId,
      status: 'queued',
      error: null,
      message: 'This row predates stored bodies, so it cannot be re-sent. Trigger it again from the invoice or ticket it came from.',
    };
  }
  const outcome = await deliver(log.id, {
    to: log.to_email,
    subject: log.subject,
    html: log.body_html,
    text: log.body_text ?? htmlToText(log.body_html),
  });
  return { log_id: log.id, ...outcome };
}

/**
 * Send everything that is waiting. Called by the Email page's "send queued now" and
 * safe to call when SMTP is off — it simply finds nothing it can do.
 */
export async function drainQueued(limit = 25): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  const cfg = await readSmtpConfig();
  if (!cfg.ready) return { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  const rows = await prisma.emailLog.findMany({
    where: { status: 'queued' },
    orderBy: { created_at: 'asc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.body_html) {
      skipped += 1;
      continue;
    }
    const outcome = await deliver(row.id, {
      to: row.to_email,
      subject: row.subject,
      html: row.body_html,
      text: row.body_text ?? htmlToText(row.body_html),
    });
    if (outcome.status === 'sent') sent += 1;
    else if (outcome.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return { attempted: rows.length, sent, failed, skipped };
}

/**
 * Prove the configuration works end to end. Deliberately renders its own body
 * rather than a template: the question being answered is "can this server send
 * mail at all", and a broken template would confuse the answer.
 */
export async function sendTestEmail(to: string, actor: string): Promise<SendResult> {
  const tokens = await baseTokens();
  const html = shell(
    `<h1 style="${H1}">SMTP works.</h1>` +
      `<p style="${P}">This test was sent from the ${tokens.platform_name} admin panel by ${escapeHtml(actor)}. ` +
      `If you are reading it, outbound mail is configured correctly.</p>`,
  );
  return sendMail({
    to,
    subject: `${tokens.platform_name}: SMTP test`,
    html: renderTokens(html, tokens),
    kind: 'admin_test',
    template_key: null,
  });
}

/** Verify the connection without sending anything. */
export async function verifySmtp(): Promise<{ ok: boolean; error: string | null }> {
  const cfg = await readSmtpConfig();
  if (!cfg.ready) return { ok: false, error: 'SMTP is not configured, or is switched off.' };
  const tx = await getTransport();
  if (!tx) return { ok: false, error: 'No usable transport.' };
  try {
    await tx.verify();
    return { ok: true, error: null };
  } catch (err) {
    const sealed = await getSetting(KEYS.password);
    return { ok: false, error: safeError(err, [open(sealed) ?? '', cfg.user]) };
  }
}
