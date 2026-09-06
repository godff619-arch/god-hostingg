// Notifications API: the in-app feed plus the workspace's delivery preferences
// and outbound channels (Part A sidebar → INTEGRATIONS → Notifications).
//
// The feed is per user: a row is only ever read, marked or deleted by the user it
// was written for, so there is no cross-tenant surface here at all. Preferences
// and channels are workspace-scoped and go through `resolveWorkspace`, which
// answers 404 (not 403) for a workspace the caller is not a member of, so ids
// cannot be probed. A channel's destination URL is a credential — it is sealed
// at rest and never returned, only its host as a hint.

import express, { Response } from 'express';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { seal, open } from '../lib/secretBox.js';
import {
  assertWorkspaceWrite,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
} from '../lib/workspace.js';
import {
  DEFAULTS,
  NOTIFICATION_EVENTS,
  normalizeLevel,
  notificationSettings,
  postJson,
  type NotificationEvent,
} from '../lib/notify.js';
import { liveAnnouncementsFor } from '../lib/announcements.js';

const router = express.Router();

const PAGE_SIZE = 30;
const MAX_NAME = 60;
const CHANNEL_KINDS = ['slack', 'webhook'] as const;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Reject anything that is not an https URL we are willing to POST to. */
function validEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Display hint for a sealed destination: the host only, never the token path. */
function endpointHint(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

function shapeChannel(row: {
  id: string;
  kind: string;
  name: string;
  hint: string;
  enabled: boolean;
  last_result: string | null;
  last_sent_at: Date | null;
  created_at: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    hint: row.hint,
    enabled: row.enabled,
    last_result: row.last_result,
    last_sent_at: row.last_sent_at,
    created_at: row.created_at,
  };
}

// ------------------------------------------------------------------- the feed

/**
 * GET /api/notifications/announcements — platform notices the caller should see now
 * (§22). Distinct from the feed: a banner is not a notification, it is a statement
 * that is true for a window of time, and the audience is evaluated on every read so
 * a plan change takes effect without anything being re-published.
 *
 * Declared before `GET /` only for readability; they do not overlap.
 */
router.get('/announcements', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const announcements = await liveAnnouncementsFor(req.user!.userId);
    res.json({ announcements });
  } catch (err: any) {
    fail(res, 500, 'announcements_failed', err?.message || 'Could not load announcements.');
  }
});

// GET /api/notifications — one page of the caller's own notifications.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const unreadOnly = req.query.unread === 'true';

    // Preferences and channels belong to the workspace in the switcher; the feed
    // itself shows that workspace's notices plus account-level ones (workspace_id
    // NULL), which belong to no single workspace but still matter here.
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const scope = { user_id: userId, OR: [{ workspace_id: workspace.id }, { workspace_id: null }] };
    const where = { ...scope, ...(unreadOnly ? { read_at: null } : {}) };

    const [total, unread, rows, settings, channels] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { ...scope, read_at: null } }),
      prisma.notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      notificationSettings(workspace.id),
      prisma.notificationChannel.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    res.json({
      workspace: { id: workspace.id, name: workspace.name },
      available_events: NOTIFICATION_EVENTS,
      channel_kinds: CHANNEL_KINDS,
      settings: {
        default_level: settings.default_level,
        include_preview: settings.include_preview,
        events: settings.events,
        // False until the workspace saves once — the UI says "using defaults".
        saved: settings.saved,
      },
      channels: channels.map(shapeChannel),
      total,
      unread,
      page,
      page_size: PAGE_SIZE,
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        severity: row.severity,
        resource: row.resource,
        link: row.link,
        read_at: row.read_at,
        created_at: row.created_at,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load notifications.');
  }
});

// POST /api/notifications/:id/read — mark one row read (idempotent).
router.post('/:id/read', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Scoping the update by user_id is the whole access check: another user's id
    // simply matches nothing and answers 404.
    const updated = await prisma.notification.updateMany({
      where: { id: req.params.id, user_id: req.user!.userId },
      data: { read_at: new Date() },
    });
    if (updated.count === 0) return fail(res, 404, 'NOT_FOUND', 'Notification not found.');
    res.json({ success: true });
  } catch (err) {
    console.error('[notifications] mark read failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the notification.');
  }
});

// POST /api/notifications/read-all — mark the whole workspace feed read.
router.post('/read-all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const updated = await prisma.notification.updateMany({
      where: {
        user_id: req.user!.userId,
        read_at: null,
        OR: [{ workspace_id: workspace.id }, { workspace_id: null }],
      },
      data: { read_at: new Date() },
    });
    res.json({ success: true, marked: updated.count });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] mark all failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the notifications.');
  }
});

// DELETE /api/notifications — clear the caller's feed for this workspace.
router.delete('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const removed = await prisma.notification.deleteMany({
      where: {
        user_id: req.user!.userId,
        OR: [{ workspace_id: workspace.id }, { workspace_id: null }],
      },
    });
    res.json({ success: true, removed: removed.count });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] clear failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not clear the feed.');
  }
});

// ------------------------------------------------------------- preferences

// PATCH /api/notifications/settings — save the workspace's delivery preferences.
router.patch('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const current = await notificationSettings(workspace.id);
    const level =
      req.body?.default_level === undefined
        ? current.default_level
        : normalizeLevel(req.body.default_level);
    if (req.body?.default_level !== undefined && level !== req.body.default_level) {
      return fail(res, 400, 'INVALID_LEVEL', 'Level must be all, failure or none.');
    }

    let events: NotificationEvent[] = current.events;
    if (req.body?.events !== undefined) {
      if (!Array.isArray(req.body.events)) {
        return fail(res, 400, 'INVALID_EVENTS', 'Events must be an array.');
      }
      const unknown = req.body.events.filter(
        (e: unknown) => !NOTIFICATION_EVENTS.includes(e as NotificationEvent),
      );
      if (unknown.length) return fail(res, 400, 'INVALID_EVENT', `Unknown event: ${unknown[0]}`);
      events = [...new Set(req.body.events as NotificationEvent[])];
    }

    const includePreview =
      typeof req.body?.include_preview === 'boolean'
        ? req.body.include_preview
        : current.include_preview;

    const saved = await prisma.notificationSetting.upsert({
      where: { workspace_id: workspace.id },
      update: { default_level: level, include_preview: includePreview, events },
      create: {
        workspace_id: workspace.id,
        default_level: level,
        include_preview: includePreview,
        events,
      },
    });
    await writeAudit(req, 'notifications.settings.update', `workspace:${workspace.id}`, {
      default_level: level,
      include_preview: includePreview,
      events,
    });
    res.json({
      success: true,
      settings: {
        default_level: saved.default_level,
        include_preview: saved.include_preview,
        events,
        saved: true,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] settings save failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the preferences.');
  }
});

// POST /api/notifications/settings/reset — go back to the platform defaults.
router.delete('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);
    await prisma.notificationSetting.deleteMany({ where: { workspace_id: workspace.id } });
    await writeAudit(req, 'notifications.settings.reset', `workspace:${workspace.id}`);
    res.json({ success: true, settings: { ...DEFAULTS, saved: false } });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] settings reset failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not reset the preferences.');
  }
});

// ---------------------------------------------------------------- channels

// POST /api/notifications/channels — add a Slack or generic webhook destination.
router.post('/channels', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > MAX_NAME) {
      return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);
    }
    const kind = String(req.body?.kind || '').toLowerCase();
    if (!CHANNEL_KINDS.includes(kind as never)) {
      return fail(res, 400, 'INVALID_KIND', 'Channel must be slack or webhook.');
    }
    const target = validEndpoint(req.body?.target);
    if (!target) return fail(res, 400, 'INVALID_URL', 'Destination must be an https:// URL.');

    const channel = await prisma.notificationChannel.create({
      data: {
        workspace_id: workspace.id,
        kind,
        name,
        target_enc: seal(target),
        hint: endpointHint(target),
      },
    });
    await writeAudit(req, 'notifications.channel.create', `notification_channel:${channel.id}`, {
      kind,
      name,
      host: channel.hint,
    });
    res.status(201).json({ success: true, channel: shapeChannel(channel) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] channel create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not add the channel.');
  }
});

// PATCH /api/notifications/channels/:id — rename, re-point or enable/disable.
router.patch('/channels/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id: req.params.id } });
    if (!channel) return fail(res, 404, 'NOT_FOUND', 'Channel not found.');
    const workspace = await resolveWorkspace(req, channel.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    const data: {
      name?: string;
      enabled?: boolean;
      target_enc?: string;
      hint?: string;
    } = {};
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (!name || name.length > MAX_NAME) {
        return fail(res, 400, 'INVALID_NAME', `Name must be 1–${MAX_NAME} characters.`);
      }
      data.name = name;
    }
    if (typeof req.body?.enabled === 'boolean') data.enabled = req.body.enabled;
    if (req.body?.target !== undefined) {
      const target = validEndpoint(req.body.target);
      if (!target) return fail(res, 400, 'INVALID_URL', 'Destination must be an https:// URL.');
      data.target_enc = seal(target);
      data.hint = endpointHint(target);
    }
    if (Object.keys(data).length === 0) return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');

    const updated = await prisma.notificationChannel.update({ where: { id: channel.id }, data });
    await writeAudit(
      req,
      'notifications.channel.update',
      `notification_channel:${channel.id}`,
      Object.keys(data),
    );
    res.json({ success: true, channel: shapeChannel(updated) });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] channel update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the channel.');
  }
});

// POST /api/notifications/channels/:id/test — deliver a real test message.
router.post('/channels/:id/test', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id: req.params.id } });
    if (!channel) return fail(res, 404, 'NOT_FOUND', 'Channel not found.');
    const workspace = await resolveWorkspace(req, channel.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    const target = open(channel.target_enc);
    if (!target) {
      // The stored destination cannot be decrypted; say so instead of reporting
      // a delivery failure that looks like the receiver's fault.
      await prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { last_result: 'failed', last_sent_at: new Date() },
      });
      return fail(res, 409, 'UNREADABLE_TARGET', 'Re-enter the destination URL for this channel.');
    }

    const started = Date.now();
    const ok = await postJson(
      target,
      channel.kind === 'slack'
        ? { text: `:bell: *Test notification from ${workspace.name}*\nChannels are wired up correctly.` }
        : {
            event: 'system',
            severity: 'info',
            title: `Test notification from ${workspace.name}`,
            body: 'Channels are wired up correctly.',
            workspace_id: workspace.id,
            sent_at: new Date().toISOString(),
          },
    );
    await prisma.notificationChannel.update({
      where: { id: channel.id },
      data: { last_result: ok ? 'ok' : 'failed', last_sent_at: new Date() },
    });
    await writeAudit(req, 'notifications.channel.test', `notification_channel:${channel.id}`, { ok });
    res.json({ success: true, ok, duration_ms: Date.now() - started });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] channel test failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not test the channel.');
  }
});

// DELETE /api/notifications/channels/:id
router.delete('/channels/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id: req.params.id } });
    if (!channel) return fail(res, 404, 'NOT_FOUND', 'Channel not found.');
    const workspace = await resolveWorkspace(req, channel.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    await prisma.notificationChannel.delete({ where: { id: channel.id } });
    await writeAudit(req, 'notifications.channel.delete', `notification_channel:${channel.id}`, {
      name: channel.name,
    });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[notifications] channel delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the channel.');
  }
});

// DELETE /api/notifications/:id — remove one row from the caller's own feed.
// Registered last so the literal `/settings` and `/channels/...` paths above are
// never swallowed by this single-segment wildcard.
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const removed = await prisma.notification.deleteMany({
      where: { id: req.params.id, user_id: req.user!.userId },
    });
    if (removed.count === 0) return fail(res, 404, 'NOT_FOUND', 'Notification not found.');
    res.json({ success: true });
  } catch (err) {
    console.error('[notifications] delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the notification.');
  }
});

export default router;
