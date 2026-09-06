// Customer-facing support tickets (§23) — the other half of the admin inbox.
//
// Without this the admin's Support page would be a permanently empty table, so it
// exists for the same reason the admin one does: a ticket has to be openable by the
// person who has the problem.
//
// Two rules:
//
//   1. A caller sees their own tickets and nothing else. Every lookup is scoped by
//      `user_id`, so changing the id in the URL returns 404, not someone else's
//      conversation.
//   2. Internal notes never leave the admin panel. The thread returned here filters
//      `internal: true` out in the query, not in the response mapper — there is no
//      code path that could forget.

import express, { Response } from 'express';
import { randomBytes } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { requestedWorkspaceId, resolveWorkspace } from '../lib/workspace.js';
import { privilegedRoleWhere } from '../lib/platformRoles.js';

const router = express.Router();

/** Priorities a customer may choose. `urgent` is triage-only, set by an operator. */
const USER_PRIORITIES = ['low', 'normal', 'high'] as const;
const CATEGORIES = ['billing', 'deployment', 'domain', 'account', 'other'] as const;
/** Open tickets one account may hold at once — a ceiling on accidental spam. */
const OPEN_TICKET_CAP = 10;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

function trimmed(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** `tkt-` + 8 hex, matching the id format the schema documents. */
function ticketId(): string {
  return `tkt-${randomBytes(4).toString('hex')}`;
}

/** GET /api/support/tickets — the caller's own tickets, newest activity first. */
router.get('/tickets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.supportTicket.findMany({
      where: { user_id: req.user!.userId },
      orderBy: { updated_at: 'desc' },
      take: 100,
      include: { _count: { select: { messages: { where: { internal: false } } } } },
    });
    res.json({
      tickets: rows.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        message_count: t._count.messages,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at ? t.updated_at.toISOString() : null,
        resolved_at: t.resolved_at ? t.resolved_at.toISOString() : null,
      })),
      priorities: USER_PRIORITIES,
      categories: CATEGORIES,
      open_cap: OPEN_TICKET_CAP,
    });
  } catch (err: any) {
    fail(res, 500, 'tickets_failed', err?.message || 'Could not load your tickets.');
  }
});

/**
 * POST /api/support/tickets — open one. The first message is stored as a message
 * rather than on the ticket, so the thread has a single shape from the start.
 *
 * Operators are notified in-app. A support inbox nobody is told about is a support
 * inbox nobody reads.
 */
router.post('/tickets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const subject = trimmed(req.body?.subject, 200);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 20_000) : '';
    if (!subject) return fail(res, 400, 'no_subject', 'Give the ticket a subject.');
    if (body.length < 10) {
      return fail(res, 400, 'no_body', 'Describe the problem — at least a sentence, so support can act on it.');
    }
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'other';
    const priority = USER_PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'normal';

    const open = await prisma.supportTicket.count({
      where: { user_id: userId, status: { in: ['open', 'pending', 'in_progress'] } },
    });
    if (open >= OPEN_TICKET_CAP) {
      return fail(
        res,
        429,
        'too_many_open',
        `You already have ${open} open tickets. Reply on one of those instead of opening another.`,
      );
    }

    // The workspace in the switcher, when there is one — it tells support which
    // account's resources the problem is about. Best-effort: a ticket is still
    // openable by someone whose workspace cannot be resolved.
    let workspaceId: string | null = null;
    try {
      const ws = await resolveWorkspace(req, requestedWorkspaceId(req));
      workspaceId = ws.id;
    } catch {
      workspaceId = null;
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        id: ticketId(),
        user_id: userId,
        workspace_id: workspaceId,
        subject,
        priority,
        category,
        status: 'open',
        messages: { create: { author: 'user', author_id: userId, body, internal: false } },
      },
      include: { messages: true },
    });

    const operators = await prisma.user.findMany({
      where: { ...privilegedRoleWhere, status: 'active' },
      select: { id: true },
    });
    if (operators.length > 0) {
      await prisma.notification.createMany({
        data: operators.map((op) => ({
          user_id: op.id,
          type: 'system',
          title: `New support ticket: ${subject}`,
          body: body.slice(0, 500),
          severity: priority === 'high' ? 'warning' : 'info',
          resource: `support_ticket:${ticket.id}`,
          link: `/admin/support/${ticket.id}`,
        })),
      });
    }

    await writeAudit(req, 'support.ticket.create', {
      target_type: 'support_ticket',
      target_id: ticket.id,
      target_label: subject,
      severity: 'info',
      metadata: { category, priority },
    });

    res.status(201).json({
      success: true,
      ticket: { id: ticket.id, subject, status: ticket.status, priority, category },
      message: 'Ticket opened. Support will reply by email and here.',
    });
  } catch (err: any) {
    fail(res, 500, 'create_failed', err?.message || 'Could not open the ticket.');
  }
});

/**
 * GET /api/support/tickets/:id — one of the caller's own threads. The `user_id` is
 * part of the where clause, so another account's id is a 404 rather than a leak.
 */
router.get('/tickets/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, user_id: req.user!.userId },
      include: {
        // Internal notes are excluded in the query, not the mapper.
        messages: { where: { internal: false }, orderBy: { created_at: 'asc' } },
      },
    });
    if (!ticket) return fail(res, 404, 'not_found', 'No such ticket.');
    res.json({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        created_at: ticket.created_at.toISOString(),
        updated_at: ticket.updated_at ? ticket.updated_at.toISOString() : null,
        resolved_at: ticket.resolved_at ? ticket.resolved_at.toISOString() : null,
      },
      messages: ticket.messages.map((m) => ({
        id: m.id,
        author: m.author,
        body: m.body,
        created_at: m.created_at.toISOString(),
      })),
    });
  } catch (err: any) {
    fail(res, 500, 'ticket_failed', err?.message || 'Could not load that ticket.');
  }
});

/**
 * POST /api/support/tickets/:id/messages — reply. A reply to a resolved ticket
 * reopens it: the customer saying "this is still broken" is the definition of not
 * resolved, and making them open a second ticket loses the history.
 */
router.post('/tickets/:id/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, user_id: userId },
    });
    if (!ticket) return fail(res, 404, 'not_found', 'No such ticket.');
    if (ticket.status === 'closed' && ticket.resolved_at) {
      const closedFor = Date.now() - ticket.resolved_at.getTime();
      // A closed ticket reopens for a fortnight; after that the trail is cold enough
      // that a fresh ticket is the more useful answer.
      if (closedFor > 14 * 24 * 60 * 60 * 1000) {
        return fail(res, 409, 'too_old', 'This ticket has been closed too long. Open a new one and reference this id.');
      }
    }
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 20_000) : '';
    if (!body) return fail(res, 400, 'empty_reply', 'Write something before sending.');

    const message = await prisma.supportMessage.create({
      data: { ticket_id: ticket.id, author: 'user', author_id: userId, body, internal: false },
    });
    const reopened = ticket.status === 'resolved' || ticket.status === 'closed';
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: reopened ? { status: 'open', resolved_at: null } : { updated_at: new Date() },
    });

    if (ticket.assignee_id) {
      // Straight to whoever owns it. Everyone else already saw the ticket open.
      await prisma.notification.create({
        data: {
          user_id: ticket.assignee_id,
          type: 'system',
          title: `Reply on ${ticket.id}: ${ticket.subject}`,
          body: body.slice(0, 500),
          severity: 'info',
          resource: `support_ticket:${ticket.id}`,
          link: `/admin/support/${ticket.id}`,
        },
      });
    }

    res.status(201).json({
      success: true,
      message: { id: message.id, author: 'user', body, created_at: message.created_at.toISOString() },
      reopened,
    });
  } catch (err: any) {
    fail(res, 500, 'reply_failed', err?.message || 'Could not send your reply.');
  }
});

export default router;
