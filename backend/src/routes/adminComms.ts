// Admin communication API — SMTP, email templates, the mail log, announcements
// and the support inbox (spec §21, §22, §23).
//
// Mounted at /api/admin next to admin.ts and adminBilling.ts, behind the same
// authMiddleware + requireAdminAccess + adminPermissionGate chain. Every path here
// already has a rule in that gate's table (§47): /smtp → settings.view/smtp.manage,
// /email/templates → email.view/smtp.manage, /email/test → email.send, /email →
// email.view/email.send, /announcements → email.view/announcements.manage,
// /support → support.view/support.manage. A third file is an organisational
// choice, not a third trust boundary.
//
// What this file refuses to do:
//
//   1. Report a send it did not observe. Every delivery goes through lib/mailer's
//      `deliver()`, which writes the outcome the transport actually returned. An
//      endpoint here reports `queued` when SMTP is off — never "sent".
//   2. Echo the SMTP password. `readSmtpConfig()` has no password field; the API
//      answers `has_password` instead, and a PATCH that omits the key keeps the
//      stored credential rather than blanking it.
//   3. Show a customer an internal note. Support messages carry `internal`, and
//      only the non-internal ones are ever mailed out.
import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { type AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermission } from '../lib/adminPermissions.js';
import { getSetting } from '../lib/settings.js';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_PLACEMENTS,
  refList,
  resolveAudience,
} from '../lib/announcements.js';
import {
  DEFAULT_TEMPLATES,
  EMAIL_RE,
  drainQueued,
  htmlToText,
  readSmtpConfig,
  renderTemplate,
  renderTokens,
  retryEmail,
  sendMail,
  sendTestEmail,
  verifySmtp,
  writeSmtpConfig,
  type SmtpPatch,
} from '../lib/mailer.js';

const router = Router();

// ── shared helpers ───────────────────────────────────────────────────────────

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Server-side paging (§42). Same shape as the billing router's. */
function parsePaging(req: AuthenticatedRequest): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt((req.query.pageSize as string) || '25', 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function trimmed(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function boolOf(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** The operator, for audit rows and for "sent by" in a test mail. */
function actorOf(req: AuthenticatedRequest): string {
  return req.user?.email || req.user?.userId || 'unknown admin';
}

// ── §21 SMTP configuration ───────────────────────────────────────────────────

/**
 * The configuration plus the two numbers that tell an operator whether it is
 * working: how many mails are waiting for a transport, and how many have failed.
 * Without those the page can only show a form and hope.
 */
router.get('/smtp', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [smtp, queued, failed, sent] = await Promise.all([
      readSmtpConfig(),
      prisma.emailLog.count({ where: { status: 'queued' } }),
      prisma.emailLog.count({ where: { status: 'failed' } }),
      prisma.emailLog.count({ where: { status: 'sent' } }),
    ]);
    res.json({
      smtp,
      queue: { queued, failed, sent },
      // Stated by the API rather than assumed by the page, for the same reason the
      // card endpoints state `never_stored`.
      never_returned: ['smtp.password'],
    });
  } catch (err: any) {
    fail(res, 500, 'smtp_read_failed', err?.message || 'Could not read the mail settings.');
  }
});

/**
 * Apply a patch. `password` absent means "keep the stored one" — a form that cannot
 * display the current value must not wipe it on every save. The audit row records
 * whether the credential changed, never what it changed to.
 */
router.patch('/smtp', requirePermission('smtp.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body ?? {};
    const patch: SmtpPatch = {};
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.host !== undefined) patch.host = trimmed(body.host);
    if (body.port !== undefined) patch.port = Number(body.port);
    if (body.secure !== undefined) patch.secure = Boolean(body.secure);
    if (body.user !== undefined) patch.user = trimmed(body.user);
    if (body.from_email !== undefined) patch.from_email = trimmed(body.from_email, 320);
    if (body.from_name !== undefined) patch.from_name = trimmed(body.from_name, 120);
    if (body.reply_to !== undefined) patch.reply_to = trimmed(body.reply_to, 320);
    if (typeof body.password === 'string') patch.password = body.password;

    const before = await readSmtpConfig();
    const badField = await writeSmtpConfig(patch);
    if (badField) {
      return fail(
        res,
        400,
        'invalid_smtp',
        badField === 'host'
          ? 'A host is required before SMTP can be switched on.'
          : badField === 'from_email'
            ? 'A valid sender address is required before SMTP can be switched on.'
            : `\`${badField}\` is not valid.`,
      );
    }

    const after = await readSmtpConfig();
    await writeAudit(req, 'smtp.update', {
      target_type: 'settings',
      target_id: 'smtp',
      target_label: after.host || 'smtp',
      severity: 'warning',
      before,
      after,
      metadata: { password_changed: patch.password !== undefined },
    });
    res.json({ success: true, smtp: after });
  } catch (err: any) {
    fail(res, 500, 'smtp_write_failed', err?.message || 'Could not save the mail settings.');
  }
});

/**
 * Open the connection and authenticate, without sending anything. Answers "are
 * these credentials right?" without putting a mail in anyone's inbox.
 */
router.post('/smtp/verify', requirePermission('smtp.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const result = await verifySmtp();
  await writeAudit(req, 'smtp.verify', {
    target_type: 'settings',
    target_id: 'smtp',
    severity: 'info',
    metadata: { ok: result.ok, error: result.error },
  });
  res.json(result);
});

/**
 * Send a real mail to a real address. Reports the outcome the transport gave,
 * including `queued` when SMTP is off — the one answer a "test" button must never
 * dress up as success.
 */
router.post('/email/test', requirePermission('email.send'), async (req: AuthenticatedRequest, res: Response) => {
  const to = trimmed(req.body?.to, 320) || req.user?.email || '';
  if (!EMAIL_RE.test(to)) {
    return fail(res, 400, 'invalid_recipient', 'Give a valid address to send the test to.');
  }
  try {
    const result = await sendTestEmail(to, actorOf(req));
    await writeAudit(req, 'email.test', {
      target_type: 'email',
      target_id: result.log_id,
      target_label: to,
      severity: 'info',
      metadata: { status: result.status, error: result.error },
    });
    res.json({ success: result.status === 'sent', ...result });
  } catch (err: any) {
    fail(res, 500, 'test_failed', err?.message || 'Could not send the test.');
  }
});

// ── §21 templates ────────────────────────────────────────────────────────────

/**
 * Stored rows, each annotated with the tokens the built-in for that key documents,
 * so the editor can list what may be referenced instead of the operator guessing.
 * A stored row with no built-in (an operator's own template) simply has no token
 * documentation, which is honest rather than empty.
 */
router.get('/email/templates', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.emailTemplate.findMany({ orderBy: { key: 'asc' } });
    res.json({
      templates: rows.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        subject: t.subject,
        body_html: t.body_html,
        body_text: t.body_text,
        enabled: t.enabled,
        updated_by: t.updated_by,
        updated_at: t.updated_at ? t.updated_at.toISOString() : null,
        tokens: DEFAULT_TEMPLATES.find((d) => d.key === t.key)?.tokens ?? [],
        /** True when the built-in exists, i.e. the row can be reset. */
        resettable: DEFAULT_TEMPLATES.some((d) => d.key === t.key),
      })),
    });
  } catch (err: any) {
    fail(res, 500, 'templates_failed', err?.message || 'Could not load the templates.');
  }
});

/**
 * Edit one template. `enabled: false` is a real switch, not a cosmetic one —
 * `renderTemplate()` returns null for a disabled key, so the platform stops sending
 * that kind of mail rather than quietly falling back to the built-in.
 */
router.patch(
  '/email/templates/:key',
  requirePermission('smtp.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const key = req.params.key;
      const existing = await prisma.emailTemplate.findUnique({ where: { key } });
      if (!existing) return fail(res, 404, 'not_found', 'No such template.');

      const data: Prisma.EmailTemplateUpdateInput = {};
      if (req.body?.name !== undefined) {
        const name = trimmed(req.body.name, 120);
        if (!name) return fail(res, 400, 'invalid_name', 'A template needs a name.');
        data.name = name;
      }
      if (req.body?.subject !== undefined) {
        const subject = trimmed(req.body.subject, 300);
        if (!subject) return fail(res, 400, 'invalid_subject', 'A template needs a subject.');
        data.subject = subject;
      }
      if (typeof req.body?.body_html === 'string') {
        const html = req.body.body_html.trim();
        if (!html) return fail(res, 400, 'invalid_body', 'A template needs a body.');
        if (html.length > 100_000) return fail(res, 400, 'body_too_long', 'That body is too long to store.');
        data.body_html = html;
        // Regenerate the plaintext alternative unless the caller sent its own, so an
        // edited HTML body never ships with the previous version's text part.
        if (req.body?.body_text === undefined) data.body_text = htmlToText(html);
      }
      if (typeof req.body?.body_text === 'string') data.body_text = req.body.body_text.slice(0, 100_000);
      const enabled = boolOf(req.body?.enabled);
      if (enabled !== undefined) data.enabled = enabled;
      if (Object.keys(data).length === 0) return fail(res, 400, 'nothing_to_do', 'Nothing to change.');
      data.updated_by = req.user?.userId ?? null;

      const after = await prisma.emailTemplate.update({ where: { key }, data });
      await writeAudit(req, 'email.template.update', {
        target_type: 'email_template',
        target_id: existing.id,
        target_label: key,
        severity: 'info',
        before: { subject: existing.subject, enabled: existing.enabled, body_html: existing.body_html },
        after: { subject: after.subject, enabled: after.enabled, body_html: after.body_html },
      });
      res.json({ success: true, template: after });
    } catch (err: any) {
      fail(res, 500, 'template_update_failed', err?.message || 'Could not save the template.');
    }
  },
);

/**
 * Sample values for a preview. Chosen to look like real data so an operator can see
 * whether the wording reads correctly, and deliberately obvious enough that a
 * preview can never be mistaken for a customer's actual mail.
 */
const SAMPLE_TOKENS: Record<string, string> = {
  name: 'Alex Marsh',
  email: 'alex@example.com',
  verify_url: 'https://example.com/verify?token=sample',
  reset_url: 'https://example.com/reset?token=sample',
  expires_in: '30 minutes',
  ip: '203.0.113.24',
  invoice_number: 'INV-2026-0042',
  amount: '$29.00',
  status: 'Paid',
  period: '1 Sep 2026 – 30 Sep 2026',
  due: '',
  items_html: '<p>Pro plan — monthly · $29.00</p>',
  reason: 'card_declined',
  title: 'Scheduled maintenance on Sunday',
  body_html: '<p>We will be moving a database host between 02:00 and 03:00 UTC.</p>',
  ticket_id: 'tkt-sample01',
  ticket_subject: 'Deployment stuck on build',
  reply_html: '<p>We have restarted the builder — try deploying again.</p>',
};

/**
 * Render without sending. Uses the row as it currently stands, including a disabled
 * one: an operator editing a switched-off template still needs to see their work.
 */
router.post(
  '/email/templates/:key/preview',
  requirePermission('smtp.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const row = await prisma.emailTemplate.findUnique({ where: { key: req.params.key } });
      const seed = DEFAULT_TEMPLATES.find((d) => d.key === req.params.key);
      // An unsaved draft can be previewed by sending it in the body, which is what
      // makes the editor's preview button useful before committing the change.
      const subject = trimmed(req.body?.subject, 300) || row?.subject || seed?.subject;
      const html = typeof req.body?.body_html === 'string' && req.body.body_html.trim()
        ? req.body.body_html.slice(0, 100_000)
        : row?.body_html || seed?.body_html;
      if (!subject || !html) return fail(res, 404, 'not_found', 'No such template.');

      const platform = await getSetting('platform.name');
      const tokens = { ...SAMPLE_TOKENS, platform_name: platform || 'God Hosting', app_url: 'https://example.com' };
      const renderedHtml = renderTokens(html, tokens);
      res.json({
        subject: renderTokens(subject, tokens),
        html: renderedHtml,
        text: htmlToText(renderedHtml),
        tokens_used: Object.keys(tokens).filter((t) => html.includes(`{{${t}}}`) || html.includes(`{{&${t}}}`)),
      });
    } catch (err: any) {
      fail(res, 500, 'preview_failed', err?.message || 'Could not render the preview.');
    }
  },
);

/** Put a template back to the shipped wording. Only possible where a built-in exists. */
router.post(
  '/email/templates/:key/reset',
  requirePermission('smtp.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const seed = DEFAULT_TEMPLATES.find((d) => d.key === req.params.key);
      if (!seed) return fail(res, 404, 'no_builtin', 'That template has no built-in to reset to.');
      const before = await prisma.emailTemplate.findUnique({ where: { key: seed.key } });
      const after = await prisma.emailTemplate.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          name: seed.name,
          subject: seed.subject,
          body_html: seed.body_html,
          body_text: htmlToText(seed.body_html),
          updated_by: req.user?.userId ?? null,
        },
        update: {
          name: seed.name,
          subject: seed.subject,
          body_html: seed.body_html,
          body_text: htmlToText(seed.body_html),
          enabled: true,
          updated_by: req.user?.userId ?? null,
        },
      });
      await writeAudit(req, 'email.template.reset', {
        target_type: 'email_template',
        target_id: after.id,
        target_label: seed.key,
        severity: 'warning',
        before: before ? { subject: before.subject, body_html: before.body_html } : null,
        after: { subject: after.subject, body_html: after.body_html },
      });
      res.json({ success: true, template: after });
    } catch (err: any) {
      fail(res, 500, 'reset_failed', err?.message || 'Could not reset the template.');
    }
  },
);

// ── §21 the mail log ─────────────────────────────────────────────────────────

/**
 * Every mail the platform has tried to send, with why it failed when it did. The
 * body is deliberately not in the list response — it is large, and a list is for
 * scanning; `GET /email/logs/:id` returns it.
 */
router.get('/email/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const status = trimmed(req.query.status, 40);
    const kind = trimmed(req.query.kind, 40);
    const q = trimmed(req.query.q, 200);

    const where: Prisma.EmailLogWhereInput = {};
    if (status && status !== 'all') where.status = status;
    if (kind && kind !== 'all') where.kind = kind;
    if (q) {
      where.OR = [
        { to_email: { contains: q } },
        { subject: { contains: q } },
        { template_key: { contains: q } },
      ];
    }

    const [rows, total, statuses, kinds] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          to_email: true,
          from_email: true,
          subject: true,
          template_key: true,
          status: true,
          error: true,
          kind: true,
          related_type: true,
          related_id: true,
          attempts: true,
          last_attempt_at: true,
          created_at: true,
          sent_at: true,
          body_html: true,
        },
      }),
      prisma.emailLog.count({ where }),
      prisma.emailLog.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.emailLog.groupBy({ by: ['kind'], _count: { _all: true } }),
    ]);

    res.json({
      logs: rows.map(({ body_html, ...row }) => ({
        ...row,
        created_at: row.created_at.toISOString(),
        sent_at: row.sent_at ? row.sent_at.toISOString() : null,
        last_attempt_at: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
        // Whether a retry is even possible, decided here rather than guessed by the
        // page: a queued row written before bodies were stored cannot be re-sent.
        retryable: row.status !== 'sent' && Boolean(body_html),
      })),
      total,
      page,
      pageSize,
      facets: {
        statuses: statuses.map((s) => ({ key: s.status, count: s._count._all })),
        kinds: kinds.map((k) => ({ key: k.kind, count: k._count._all })),
      },
    });
  } catch (err: any) {
    fail(res, 500, 'logs_failed', err?.message || 'Could not load the mail log.');
  }
});

/** Drain the queue on demand. Reports what it actually did, including nothing. */
router.post('/email/drain', requirePermission('email.send'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Number(req.body?.limit) > 0 ? Number(req.body.limit) : 25;
    const cfg = await readSmtpConfig();
    if (!cfg.ready) {
      return fail(
        res,
        409,
        'smtp_not_ready',
        'SMTP is off or incomplete, so nothing can be sent. Configure it first — the queue is kept.',
      );
    }
    const result = await drainQueued(limit);
    await writeAudit(req, 'email.drain', {
      target_type: 'email',
      target_id: 'queue',
      severity: 'info',
      metadata: result,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    fail(res, 500, 'drain_failed', err?.message || 'Could not drain the queue.');
  }
});

/** One mail, body included — the answer to "what exactly did we send them?". */
router.get('/email/logs/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.emailLog.findUnique({ where: { id: req.params.id } });
    if (!row) return fail(res, 404, 'not_found', 'No such mail.');
    let user: { id: string; name: string | null; email: string } | null = null;
    if (row.user_id) {
      user = await prisma.user.findUnique({
        where: { id: row.user_id },
        select: { id: true, name: true, email: true },
      });
    }
    res.json({
      log: {
        ...row,
        created_at: row.created_at.toISOString(),
        sent_at: row.sent_at ? row.sent_at.toISOString() : null,
        last_attempt_at: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
        retryable: row.status !== 'sent' && Boolean(row.body_html),
      },
      user,
    });
  } catch (err: any) {
    fail(res, 500, 'log_failed', err?.message || 'Could not load that mail.');
  }
});

/** Try one mail again. Re-uses the stored body; never re-renders from scratch. */
router.post(
  '/email/logs/:id/retry',
  requirePermission('email.send'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await retryEmail(req.params.id);
      await writeAudit(req, 'email.retry', {
        target_type: 'email',
        target_id: req.params.id,
        severity: 'info',
        metadata: { status: result.status, error: result.error },
      });
      res.json({ success: result.status === 'sent', ...result });
    } catch (err: any) {
      fail(res, 500, 'retry_failed', err?.message || 'Could not retry that mail.');
    }
  },
);

// ── §22 announcements ────────────────────────────────────────────────────────

const LEVELS = ANNOUNCEMENT_LEVELS;
const AUDIENCES = ANNOUNCEMENT_AUDIENCES;
const PLACEMENTS = ANNOUNCEMENT_PLACEMENTS;

/** The list, each row carrying the size of its audience so "who sees this?" is answerable. */
router.get('/announcements', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const state = trimmed(req.query.state, 20);
    const where: Prisma.AnnouncementWhereInput = {};
    if (state === 'published') where.published = true;
    if (state === 'draft') where.published = false;

    const [rows, total, plans] = await Promise.all([
      prisma.announcement.findMany({ where, orderBy: { created_at: 'desc' }, skip, take: pageSize }),
      prisma.announcement.count({ where }),
      prisma.plan.findMany({ select: { key: true, name: true }, orderBy: { sort_order: 'asc' } }),
    ]);

    const now = new Date();
    res.json({
      announcements: rows.map((a) => ({
        ...a,
        audience_ref: refList(a.audience_ref),
        starts_at: a.starts_at ? a.starts_at.toISOString() : null,
        ends_at: a.ends_at ? a.ends_at.toISOString() : null,
        created_at: a.created_at.toISOString(),
        updated_at: a.updated_at ? a.updated_at.toISOString() : null,
        // Derived server-side so every surface agrees on what "live" means (§61).
        live:
          a.published &&
          (!a.starts_at || a.starts_at <= now) &&
          (!a.ends_at || a.ends_at >= now),
      })),
      total,
      page,
      pageSize,
      levels: LEVELS,
      audiences: AUDIENCES,
      placements: PLACEMENTS,
      plans,
    });
  } catch (err: any) {
    fail(res, 500, 'announcements_failed', err?.message || 'Could not load announcements.');
  }
});

/** Validate the shared body of a create or an update. Returns an error message or null. */
function validateAnnouncement(body: any, isCreate: boolean): string | null {
  if (isCreate || body.title !== undefined) {
    if (!trimmed(body.title, 200)) return 'An announcement needs a title.';
  }
  if (isCreate || body.body !== undefined) {
    if (!trimmed(body.body, 20_000)) return 'An announcement needs a body.';
  }
  if (body.level !== undefined && !LEVELS.includes(body.level)) return 'Unknown level.';
  if (body.audience !== undefined && !AUDIENCES.includes(body.audience)) return 'Unknown audience.';
  if (body.placement !== undefined && !PLACEMENTS.includes(body.placement)) return 'Unknown placement.';
  if (body.audience && body.audience !== 'all' && refList(body.audience_ref).length === 0) {
    return `An audience of "${body.audience}" needs at least one selection.`;
  }
  for (const key of ['starts_at', 'ends_at']) {
    const raw = body[key];
    if (raw && Number.isNaN(new Date(raw).getTime())) return `\`${key}\` is not a date.`;
  }
  if (body.starts_at && body.ends_at && new Date(body.ends_at) <= new Date(body.starts_at)) {
    return 'It cannot end before it starts.';
  }
  return null;
}

router.post('/announcements', requirePermission('announcements.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body ?? {};
    const bad = validateAnnouncement(body, true);
    if (bad) return fail(res, 400, 'invalid_announcement', bad);
    const created = await prisma.announcement.create({
      data: {
        title: trimmed(body.title, 200),
        body: trimmed(body.body, 20_000),
        level: LEVELS.includes(body.level) ? body.level : 'info',
        audience: AUDIENCES.includes(body.audience) ? body.audience : 'all',
        audience_ref: refList(body.audience_ref),
        placement: PLACEMENTS.includes(body.placement) ? body.placement : 'inbox',
        published: Boolean(body.published),
        send_email: Boolean(body.send_email),
        starts_at: body.starts_at ? new Date(body.starts_at) : null,
        ends_at: body.ends_at ? new Date(body.ends_at) : null,
        created_by: req.user?.userId ?? null,
      },
    });
    await writeAudit(req, 'announcement.create', {
      target_type: 'announcement',
      target_id: created.id,
      target_label: created.title,
      severity: 'info',
      after: created,
    });
    res.status(201).json({ success: true, announcement: created });
  } catch (err: any) {
    fail(res, 500, 'create_failed', err?.message || 'Could not create the announcement.');
  }
});

router.patch(
  '/announcements/:id',
  requirePermission('announcements.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const before = await prisma.announcement.findUnique({ where: { id: req.params.id } });
      if (!before) return fail(res, 404, 'not_found', 'No such announcement.');
      const body = req.body ?? {};
      const bad = validateAnnouncement(body, false);
      if (bad) return fail(res, 400, 'invalid_announcement', bad);

      const data: Prisma.AnnouncementUpdateInput = {};
      if (body.title !== undefined) data.title = trimmed(body.title, 200);
      if (body.body !== undefined) data.body = trimmed(body.body, 20_000);
      if (body.level !== undefined) data.level = body.level;
      if (body.audience !== undefined) data.audience = body.audience;
      if (body.audience_ref !== undefined) data.audience_ref = refList(body.audience_ref);
      if (body.placement !== undefined) data.placement = body.placement;
      if (body.published !== undefined) data.published = Boolean(body.published);
      if (body.send_email !== undefined) data.send_email = Boolean(body.send_email);
      if (body.starts_at !== undefined) data.starts_at = body.starts_at ? new Date(body.starts_at) : null;
      if (body.ends_at !== undefined) data.ends_at = body.ends_at ? new Date(body.ends_at) : null;
      if (Object.keys(data).length === 0) return fail(res, 400, 'nothing_to_do', 'Nothing to change.');

      const after = await prisma.announcement.update({ where: { id: before.id }, data });
      await writeAudit(req, 'announcement.update', {
        target_type: 'announcement',
        target_id: after.id,
        target_label: after.title,
        severity: 'info',
        before,
        after,
      });
      res.json({ success: true, announcement: after });
    } catch (err: any) {
      fail(res, 500, 'update_failed', err?.message || 'Could not save the announcement.');
    }
  },
);

router.delete(
  '/announcements/:id',
  requirePermission('announcements.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const before = await prisma.announcement.findUnique({ where: { id: req.params.id } });
      if (!before) return fail(res, 404, 'not_found', 'No such announcement.');
      await prisma.announcement.delete({ where: { id: before.id } });
      await writeAudit(req, 'announcement.delete', {
        target_type: 'announcement',
        target_id: before.id,
        target_label: before.title,
        severity: 'warning',
        before,
        reason: trimmed(req.body?.reason, 500) || null,
      });
      res.json({ success: true });
    } catch (err: any) {
      fail(res, 500, 'delete_failed', err?.message || 'Could not delete the announcement.');
    }
  },
);

/** Publish or unpublish. Separate from PATCH so the list can have a switch. */
router.post(
  '/announcements/:id/publish',
  requirePermission('announcements.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const before = await prisma.announcement.findUnique({ where: { id: req.params.id } });
      if (!before) return fail(res, 404, 'not_found', 'No such announcement.');
      const published = req.body?.published === undefined ? !before.published : Boolean(req.body.published);
      const after = await prisma.announcement.update({ where: { id: before.id }, data: { published } });
      await writeAudit(req, published ? 'announcement.publish' : 'announcement.unpublish', {
        target_type: 'announcement',
        target_id: after.id,
        target_label: after.title,
        severity: 'info',
        before: { published: before.published },
        after: { published: after.published },
      });
      res.json({ success: true, announcement: after });
    } catch (err: any) {
      fail(res, 500, 'publish_failed', err?.message || 'Could not change that.');
    }
  },
);

/** Operator-authored plain text → safe mail HTML. Paragraphs, nothing else. */
function bodyToHtml(body: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return body
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px;">${escape(para.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

/** One announcement, with the audience it currently resolves to. */
router.get('/announcements/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!row) return fail(res, 404, 'not_found', 'No such announcement.');
    const recipients = await resolveAudience(row.audience, refList(row.audience_ref));
    const [inboxCount, emailCount] = await Promise.all([
      prisma.notification.count({ where: { resource: `announcement:${row.id}` } }),
      prisma.emailLog.count({ where: { related_type: 'announcement', related_id: row.id } }),
    ]);
    res.json({
      announcement: {
        ...row,
        audience_ref: refList(row.audience_ref),
        starts_at: row.starts_at ? row.starts_at.toISOString() : null,
        ends_at: row.ends_at ? row.ends_at.toISOString() : null,
      },
      audience: {
        size: recipients.length,
        // A sample, not the list: an audience of "all" on a busy platform is not a
        // thing to render, and the count is what the operator is deciding on.
        sample: recipients.slice(0, 10).map((u) => ({ id: u.id, name: u.name, email: u.email })),
      },
      delivered: { inbox: inboxCount, email: emailCount },
    });
  } catch (err: any) {
    fail(res, 500, 'announcement_failed', err?.message || 'Could not load that announcement.');
  }
});

/**
 * Deliver it: an in-app notification per recipient, and — when `send_email` is on —
 * one queued mail each.
 *
 * The mails are written as `queued` rows carrying their rendered body rather than
 * sent inline. A thousand SMTP round-trips inside one HTTP request would time out
 * halfway and leave nobody able to say who had been mailed; the queue drain (every
 * five minutes, or the button on the Email page) sends them and records each outcome
 * individually. So this endpoint reports what it *queued*, which is what it did.
 */
router.post(
  '/announcements/:id/deliver',
  requirePermission('announcements.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const row = await prisma.announcement.findUnique({ where: { id: req.params.id } });
      if (!row) return fail(res, 404, 'not_found', 'No such announcement.');
      if (!row.published) {
        return fail(res, 409, 'not_published', 'Publish it first — an unpublished announcement is a draft.');
      }
      const recipients = await resolveAudience(row.audience, refList(row.audience_ref));
      if (recipients.length === 0) {
        return fail(res, 409, 'empty_audience', 'That audience currently resolves to nobody.');
      }

      // Skip anyone who already has this announcement in their feed, so pressing the
      // button twice does not double-post it.
      const already = await prisma.notification.findMany({
        where: { resource: `announcement:${row.id}` },
        select: { user_id: true },
      });
      const seen = new Set(already.map((n) => n.user_id));
      const fresh = recipients.filter((u) => !seen.has(u.id));

      const severity = row.level === 'critical' ? 'error' : row.level === 'warning' ? 'warning' : 'info';
      if (fresh.length > 0) {
        await prisma.notification.createMany({
          data: fresh.map((u) => ({
            user_id: u.id,
            type: 'system',
            title: row.title,
            body: row.body.slice(0, 2000),
            severity,
            resource: `announcement:${row.id}`,
          })),
        });
      }

      let queuedEmails = 0;
      if (row.send_email) {
        const rendered = await renderTemplate('announcement', {
          title: row.title,
          body_html: bodyToHtml(row.body),
        });
        if (!rendered) {
          return fail(
            res,
            409,
            'template_disabled',
            'The announcement email template is switched off, so nothing was mailed. The in-app notices were still posted.',
          );
        }
        const mailedTo = await prisma.emailLog.findMany({
          where: { related_type: 'announcement', related_id: row.id },
          select: { to_email: true },
        });
        const mailed = new Set(mailedTo.map((m) => m.to_email));
        const targets = recipients.filter((u) => !mailed.has(u.email));
        if (targets.length > 0) {
          const cfg = await readSmtpConfig();
          await prisma.emailLog.createMany({
            data: targets.map((u) => ({
              to_email: u.email,
              from_email: cfg.from_email || null,
              subject: rendered.subject,
              template_key: 'announcement',
              status: 'queued',
              user_id: u.id,
              kind: 'announcement',
              body_html: renderTokens(rendered.html, { name: u.name, email: u.email }),
              body_text: rendered.text,
              related_type: 'announcement',
              related_id: row.id,
            })),
          });
          queuedEmails = targets.length;
        }
      }

      await writeAudit(req, 'announcement.deliver', {
        target_type: 'announcement',
        target_id: row.id,
        target_label: row.title,
        severity: 'warning',
        metadata: {
          audience: row.audience,
          audience_size: recipients.length,
          notified: fresh.length,
          queued_emails: queuedEmails,
        },
      });

      // Send now if we can, so a small audience does not wait for the next sweep.
      const cfg = await readSmtpConfig();
      const drained = queuedEmails > 0 && cfg.ready ? await drainQueued(Math.min(queuedEmails, 50)) : null;

      res.json({
        success: true,
        audience_size: recipients.length,
        notified: fresh.length,
        already_notified: recipients.length - fresh.length,
        queued_emails: queuedEmails,
        sent_now: drained?.sent ?? 0,
        message: row.send_email
          ? cfg.ready
            ? `Posted to ${fresh.length} inbox(es) and queued ${queuedEmails} mail(s); ${drained?.sent ?? 0} went out immediately.`
            : `Posted to ${fresh.length} inbox(es). ${queuedEmails} mail(s) are queued — configure SMTP and they will go out.`
          : `Posted to ${fresh.length} inbox(es). Email was not requested for this announcement.`,
      });
    } catch (err: any) {
      fail(res, 500, 'deliver_failed', err?.message || 'Could not deliver the announcement.');
    }
  },
);

// ── §23 support inbox ────────────────────────────────────────────────────────

const TICKET_STATUSES = ['open', 'pending', 'in_progress', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const CATEGORIES = ['billing', 'deployment', 'domain', 'account', 'other'] as const;

/** The requester, looked up in a batch. `user_id` is a plain column, not a relation. */
async function requesterMap(ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, { id: string; name: string; email: string; status: string }>();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true, status: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

/**
 * The inbox. Sorted by last activity rather than creation, because a ticket someone
 * has just replied to is the one that needs attention.
 */
router.get('/support/tickets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const status = trimmed(req.query.status, 20);
    const priority = trimmed(req.query.priority, 20);
    const category = trimmed(req.query.category, 20);
    const assignee = trimmed(req.query.assignee, 60);
    const q = trimmed(req.query.q, 200);

    const where: Prisma.SupportTicketWhereInput = {};
    if (status === 'unresolved') where.status = { in: ['open', 'pending', 'in_progress'] };
    else if (status && status !== 'all') where.status = status;
    if (priority && priority !== 'all') where.priority = priority;
    if (category && category !== 'all') where.category = category;
    if (assignee === 'unassigned') where.assignee_id = null;
    else if (assignee && assignee !== 'all') where.assignee_id = assignee;
    if (q) where.OR = [{ subject: { contains: q } }, { id: { contains: q } }];

    const [rows, total, statusFacets, priorityFacets, unassigned] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip,
        take: pageSize,
        include: {
          workspace: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
        },
      }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.supportTicket.groupBy({ by: ['priority'], _count: { _all: true } }),
      prisma.supportTicket.count({ where: { assignee_id: null, status: { in: ['open', 'pending', 'in_progress'] } } }),
    ]);

    const users = await requesterMap([
      ...rows.map((t) => t.user_id),
      ...rows.map((t) => t.assignee_id),
    ]);

    res.json({
      tickets: rows.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        message_count: t._count.messages,
        workspace: t.workspace,
        requester: t.user_id ? users.get(t.user_id) ?? null : null,
        assignee: t.assignee_id ? users.get(t.assignee_id) ?? null : null,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at ? t.updated_at.toISOString() : null,
        resolved_at: t.resolved_at ? t.resolved_at.toISOString() : null,
      })),
      total,
      page,
      pageSize,
      facets: {
        statuses: statusFacets.map((s) => ({ key: s.status, count: s._count._all })),
        priorities: priorityFacets.map((p) => ({ key: p.priority, count: p._count._all })),
      },
      unassigned,
      statuses: TICKET_STATUSES,
      priorities: PRIORITIES,
      categories: CATEGORIES,
    });
  } catch (err: any) {
    fail(res, 500, 'tickets_failed', err?.message || 'Could not load the support inbox.');
  }
});

/**
 * Who a ticket can be assigned to: any account with a role that can act on support.
 * Read from the role column rather than a hand-kept list, so a newly promoted
 * support admin is assignable without a code change.
 */
router.get('/support/agents', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const agents = await prisma.user.findMany({
      where: {
        status: 'active',
        role: { in: ['owner', 'super_admin', 'admin', 'support_admin', 'operations_admin', 'billing_admin'] },
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });
    res.json({ agents });
  } catch (err: any) {
    fail(res, 500, 'agents_failed', err?.message || 'Could not load the agent list.');
  }
});

/** One ticket, its whole thread, and enough about the requester to help them. */
router.get('/support/tickets/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: {
        workspace: { select: { id: true, name: true, plan_key: true } },
        messages: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!ticket) return fail(res, 404, 'not_found', 'No such ticket.');

    const users = await requesterMap([
      ticket.user_id,
      ticket.assignee_id,
      ...ticket.messages.map((m) => m.author_id),
    ]);

    res.json({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        workspace: ticket.workspace,
        requester: ticket.user_id ? users.get(ticket.user_id) ?? null : null,
        assignee: ticket.assignee_id ? users.get(ticket.assignee_id) ?? null : null,
        created_at: ticket.created_at.toISOString(),
        updated_at: ticket.updated_at ? ticket.updated_at.toISOString() : null,
        resolved_at: ticket.resolved_at ? ticket.resolved_at.toISOString() : null,
      },
      messages: ticket.messages.map((m) => ({
        id: m.id,
        author: m.author,
        author_id: m.author_id,
        author_name: m.author_id ? users.get(m.author_id)?.name ?? null : null,
        body: m.body,
        internal: m.internal,
        created_at: m.created_at.toISOString(),
      })),
      statuses: TICKET_STATUSES,
      priorities: PRIORITIES,
      categories: CATEGORIES,
    });
  } catch (err: any) {
    fail(res, 500, 'ticket_failed', err?.message || 'Could not load that ticket.');
  }
});

/**
 * Triage: status, priority, category, assignee. `resolved_at` is maintained here so
 * "how long did that take?" is answerable from the row rather than reconstructed
 * from the audit trail.
 */
router.patch(
  '/support/tickets/:id',
  requirePermission('support.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const before = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
      if (!before) return fail(res, 404, 'not_found', 'No such ticket.');
      const body = req.body ?? {};
      const data: Prisma.SupportTicketUpdateInput = {};

      if (body.status !== undefined) {
        if (!TICKET_STATUSES.includes(body.status)) return fail(res, 400, 'invalid_status', 'Unknown status.');
        data.status = body.status;
        const isDone = body.status === 'resolved' || body.status === 'closed';
        // Set on the way in, cleared on the way out — a reopened ticket is not resolved.
        if (isDone && !before.resolved_at) data.resolved_at = new Date();
        if (!isDone && before.resolved_at) data.resolved_at = null;
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) return fail(res, 400, 'invalid_priority', 'Unknown priority.');
        data.priority = body.priority;
      }
      if (body.category !== undefined) {
        if (!CATEGORIES.includes(body.category)) return fail(res, 400, 'invalid_category', 'Unknown category.');
        data.category = body.category;
      }
      if (body.assignee_id !== undefined) {
        const assignee = trimmed(body.assignee_id, 60);
        if (assignee) {
          const exists = await prisma.user.findUnique({ where: { id: assignee }, select: { id: true } });
          if (!exists) return fail(res, 400, 'no_such_agent', 'That agent does not exist.');
          data.assignee_id = assignee;
        } else {
          data.assignee_id = null;
        }
      }
      if (Object.keys(data).length === 0) return fail(res, 400, 'nothing_to_do', 'Nothing to change.');

      const after = await prisma.supportTicket.update({ where: { id: before.id }, data });
      await writeAudit(req, 'support.ticket.update', {
        target_type: 'support_ticket',
        target_id: after.id,
        target_label: after.subject,
        severity: 'info',
        reason: trimmed(body.reason, 500) || null,
        before: {
          status: before.status,
          priority: before.priority,
          category: before.category,
          assignee_id: before.assignee_id,
        },
        after: {
          status: after.status,
          priority: after.priority,
          category: after.category,
          assignee_id: after.assignee_id,
        },
      });
      res.json({ success: true, ticket: after });
    } catch (err: any) {
      fail(res, 500, 'ticket_update_failed', err?.message || 'Could not update the ticket.');
    }
  },
);

/**
 * Reply, or leave an internal note. An internal note is never mailed and never
 * shown to the customer — that distinction is the whole reason the column exists,
 * so it is enforced here rather than left to the page that renders it.
 *
 * The reply's mail status is returned as it happened. If SMTP is off, the reply is
 * still recorded on the thread and the mail is queued; the response says so instead
 * of claiming the customer has been told.
 */
router.post(
  '/support/tickets/:id/messages',
  requirePermission('support.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
      if (!ticket) return fail(res, 404, 'not_found', 'No such ticket.');
      const text = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 20_000) : '';
      if (!text) return fail(res, 400, 'empty_reply', 'A reply needs a body.');
      const internal = Boolean(req.body?.internal);

      const message = await prisma.supportMessage.create({
        data: {
          ticket_id: ticket.id,
          author: 'admin',
          author_id: req.user?.userId ?? null,
          body: text,
          internal,
        },
      });

      // Answering moves an open ticket to in_progress unless the operator asked for
      // a specific status in the same call — a replied-to ticket is not "open, nobody
      // has looked at it".
      const nextStatus = TICKET_STATUSES.includes(req.body?.status)
        ? req.body.status
        : !internal && ticket.status === 'open'
          ? 'in_progress'
          : null;
      const resolved = nextStatus === 'resolved' || nextStatus === 'closed';
      if (nextStatus) {
        await prisma.supportTicket.update({
          where: { id: ticket.id },
          data: {
            status: nextStatus,
            resolved_at: resolved ? ticket.resolved_at ?? new Date() : null,
          },
        });
      } else {
        // Touch it so the inbox's "last activity" order reflects the note.
        await prisma.supportTicket.update({ where: { id: ticket.id }, data: { updated_at: new Date() } });
      }

      let mail: { status: string; message: string } | null = null;
      if (!internal && ticket.user_id) {
        const user = await prisma.user.findUnique({
          where: { id: ticket.user_id },
          select: { email: true, name: true },
        });
        const rendered = user
          ? await renderTemplate('support_reply', {
              ticket_id: ticket.id,
              ticket_subject: ticket.subject,
              reply_html: bodyToHtml(text),
              name: user.name,
            })
          : null;
        if (user && rendered) {
          const sent = await sendMail({
            to: user.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            template_key: 'support_reply',
            kind: 'transactional',
            user_id: ticket.user_id,
            related_type: 'support_ticket',
            related_id: ticket.id,
          });
          mail = { status: sent.status, message: sent.message };
        } else if (user) {
          mail = {
            status: 'skipped',
            message: 'The support reply template is switched off, so no mail was sent.',
          };
        }
      }

      await writeAudit(req, internal ? 'support.note' : 'support.reply', {
        target_type: 'support_ticket',
        target_id: ticket.id,
        target_label: ticket.subject,
        severity: 'info',
        metadata: { internal, mail_status: mail?.status ?? 'none', status: nextStatus ?? ticket.status },
      });

      res.status(201).json({ success: true, message, mail, status: nextStatus ?? ticket.status });
    } catch (err: any) {
      fail(res, 500, 'reply_failed', err?.message || 'Could not post the reply.');
    }
  },
);

export default router;
