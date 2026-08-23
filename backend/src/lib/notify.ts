// Notification delivery: the in-app feed plus outbound Slack/webhook channels.
//
// Every writer goes through `notify()`, which is deliberately fail-safe — it
// swallows its own errors so a delivery problem can never fail a deploy or a
// request. Preferences are per workspace (`NotificationSetting`); when no row
// exists the defaults in `DEFAULTS` apply, so a workspace that has never opened
// the page still gets failure notices.
//
// There is no email channel: this deployment has no mailer configured, and a
// toggle that silently does nothing would be worse than its absence.

import prisma from './prisma.js';
import { open } from './secretBox.js';

/** Events a workspace can subscribe to. */
export const NOTIFICATION_EVENTS = [
  'deploy.succeeded',
  'deploy.failed',
  'service.suspended',
  'quota.exceeded',
  'billing',
  'system',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationLevel = 'all' | 'failure' | 'none';

export type Severity = 'info' | 'warning' | 'error';

/**
 * Events that always reach the feed regardless of `default_level`. These are
 * account-critical: a spend cap or a suspension is not a lifecycle update the
 * user can opt out of by setting deploy notifications to "none".
 */
const ALWAYS: ReadonlySet<string> = new Set(['quota.exceeded', 'billing', 'system']);

/** Severity per event, so callers cannot mislabel a failure as informational. */
const SEVERITY: Record<NotificationEvent, Severity> = {
  'deploy.succeeded': 'info',
  'deploy.failed': 'error',
  'service.suspended': 'warning',
  'quota.exceeded': 'warning',
  billing: 'info',
  system: 'info',
};

export const DEFAULTS: {
  default_level: NotificationLevel;
  include_preview: boolean;
  events: NotificationEvent[];
} = {
  default_level: 'failure',
  include_preview: false,
  events: ['deploy.failed', 'service.suspended', 'quota.exceeded', 'billing', 'system'],
};

/** Stored preferences for a workspace, or the defaults when nothing is saved. */
export async function notificationSettings(workspaceId: string | null | undefined): Promise<{
  default_level: NotificationLevel;
  include_preview: boolean;
  events: NotificationEvent[];
  saved: boolean;
}> {
  if (!workspaceId) return { ...DEFAULTS, saved: false };
  const row = await prisma.notificationSetting
    .findUnique({ where: { workspace_id: workspaceId } })
    .catch(() => null);
  if (!row) return { ...DEFAULTS, saved: false };
  const events = Array.isArray(row.events)
    ? (row.events as unknown[]).filter((e): e is NotificationEvent =>
        NOTIFICATION_EVENTS.includes(e as NotificationEvent),
      )
    : DEFAULTS.events;
  return {
    default_level: normalizeLevel(row.default_level),
    include_preview: row.include_preview,
    events,
    saved: true,
  };
}

export function normalizeLevel(value: unknown): NotificationLevel {
  return value === 'all' || value === 'none' ? value : 'failure';
}

/**
 * True when this event should be delivered under the given preferences.
 * `failure` means only things that went wrong; `none` silences the lifecycle
 * but never the always-on events above.
 */
function subscribed(
  event: NotificationEvent,
  settings: { default_level: NotificationLevel; events: NotificationEvent[] },
): boolean {
  if (ALWAYS.has(event)) return true;
  if (!settings.events.includes(event)) return false;
  if (settings.default_level === 'none') return false;
  if (settings.default_level === 'failure') return SEVERITY[event] !== 'info';
  return true;
}

export interface NotifyInput {
  event: NotificationEvent;
  title: string;
  body?: string | null;
  /** Workspace the notice belongs to. NULL = account-level. */
  workspaceId?: string | null;
  /**
   * Explicit recipients. When omitted, every active member of the workspace is
   * notified — the page is workspace-scoped, so the feed is a shared one.
   */
  userIds?: string[];
  resource?: string | null;
  /** In-app path the row links to, e.g. `/projects/<id>`. */
  link?: string | null;
}

/**
 * Record a notification and fan it out to the workspace's channels. Never
 * throws: a delivery failure must not turn into a failed deploy.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const settings = await notificationSettings(input.workspaceId);
    if (!subscribed(input.event, settings)) return;

    const recipients = input.userIds?.length
      ? [...new Set(input.userIds)]
      : await activeMemberIds(input.workspaceId);
    const severity = SEVERITY[input.event];

    if (recipients.length > 0) {
      await prisma.notification.createMany({
        data: recipients.map((userId) => ({
          user_id: userId,
          workspace_id: input.workspaceId ?? null,
          type: input.event,
          title: input.title,
          body: input.body ?? null,
          severity,
          resource: input.resource ?? null,
          link: input.link ?? null,
        })),
      });
    }

    await deliverToChannels(input, severity);
  } catch (err) {
    console.warn('[notify] delivery skipped:', err instanceof Error ? err.message : err);
  }
}

/** Active members of a workspace, by user id. Invited-but-unregistered rows have none. */
async function activeMemberIds(workspaceId: string | null | undefined): Promise<string[]> {
  if (!workspaceId) return [];
  const members = await prisma.workspaceMember.findMany({
    where: { workspace_id: workspaceId, status: 'active', user_id: { not: null } },
    select: { user_id: true },
  });
  return members.map((m) => m.user_id as string);
}

/** POST the notice to every enabled channel, recording each outcome. */
async function deliverToChannels(input: NotifyInput, severity: Severity): Promise<void> {
  if (!input.workspaceId) return;
  const channels = await prisma.notificationChannel.findMany({
    where: { workspace_id: input.workspaceId, enabled: true },
  });
  if (channels.length === 0) return;

  await Promise.all(
    channels.map(async (channel) => {
      const target = open(channel.target_enc);
      // A destination that cannot be decrypted (rotated key) is reported as a
      // failure rather than silently skipped, so the page shows the problem.
      if (!target) {
        await markChannel(channel.id, 'failed');
        return;
      }
      const ok = await postJson(
        target,
        channel.kind === 'slack'
          ? { text: slackText(input, severity) }
          : {
              event: input.event,
              severity,
              title: input.title,
              body: input.body ?? null,
              resource: input.resource ?? null,
              workspace_id: input.workspaceId,
              sent_at: new Date().toISOString(),
            },
      );
      await markChannel(channel.id, ok ? 'ok' : 'failed');
    }),
  );
}

function slackText(input: NotifyInput, severity: Severity): string {
  const icon = severity === 'error' ? ':x:' : severity === 'warning' ? ':warning:' : ':white_check_mark:';
  return input.body ? `${icon} *${input.title}*\n${input.body}` : `${icon} *${input.title}*`;
}

async function markChannel(id: string, result: 'ok' | 'failed'): Promise<void> {
  await prisma.notificationChannel
    .update({ where: { id }, data: { last_result: result, last_sent_at: new Date() } })
    .catch(() => {});
}

/** One POST with a hard timeout. Returns whether the destination accepted it. */
export async function postJson(url: string, payload: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell a user that a quota stopped them. Delivered to their own workspace so
 * the notice lands in the feed they actually look at, and always sent — a spend
 * or capacity limit is not something the lifecycle preference can silence.
 */
export async function notifyQuota(userId: string, message: string): Promise<void> {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { owner_id: userId },
      select: { id: true },
    });
    await notify({
      event: 'quota.exceeded',
      workspaceId: workspace?.id ?? null,
      userIds: [userId],
      title: 'Plan limit reached',
      body: message,
      link: '/billing',
    });
  } catch (err) {
    console.warn('[notify] quota notice skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Announce a finished deployment. Resolves the resource's workspace and
 * environment itself so call sites in the deploy path stay a single line, and
 * honours `include_preview` for non-default environments.
 */
export async function notifyDeployment(
  projectId: string,
  status: 'success' | 'failed',
): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        user_id: true,
        environment: { select: { name: true, is_default: true } },
        workspace_project: { select: { workspace_id: true } },
      },
    });
    if (!project) return;

    const workspaceId = project.workspace_project?.workspace_id ?? null;
    const settings = await notificationSettings(workspaceId);
    const environment = project.environment;
    if (environment && !environment.is_default && !settings.include_preview) return;

    const event: NotificationEvent = status === 'success' ? 'deploy.succeeded' : 'deploy.failed';
    const where = environment ? ` in ${environment.name}` : '';
    // Active members plus the resource owner, who must hear about their own
    // deploy even if no membership row names them.
    const members = await activeMemberIds(workspaceId);
    const recipients = [...new Set([...members, ...(project.user_id ? [project.user_id] : [])])];
    await notify({
      event,
      workspaceId,
      userIds: recipients,
      title:
        status === 'success'
          ? `${project.name} deployed successfully`
          : `${project.name} failed to deploy`,
      body:
        status === 'success'
          ? `The latest deploy${where} finished without errors.`
          : `The latest deploy${where} did not complete. Open the deploy log for the failing step.`,
      resource: `project:${project.id}`,
      link: `/projects/${project.id}`,
    });
  } catch (err) {
    console.warn('[notify] deployment notice skipped:', err instanceof Error ? err.message : err);
  }
}
