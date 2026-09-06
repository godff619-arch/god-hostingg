// Announcement audience resolution (§22) — shared by the admin writer and the
// customer-facing reader.
//
// One rule shapes it: the audience is evaluated at read time, not frozen at publish
// time. An announcement for the `pro` plan stops showing to someone who downgrades,
// and starts showing to someone who upgrades, without being re-published. The
// alternative — a materialised recipient list — silently lies the moment anything
// about the account changes.
//
// Suspended accounts are excluded everywhere. They cannot sign in to read a banner,
// and mailing them platform news is noise.

import prisma from './prisma.js';

export const ANNOUNCEMENT_LEVELS = ['info', 'warning', 'critical', 'success'] as const;
export const ANNOUNCEMENT_AUDIENCES = ['all', 'plan', 'role', 'user'] as const;
export const ANNOUNCEMENT_PLACEMENTS = ['banner', 'modal', 'inbox'] as const;

/** `audience_ref` is a JSON column; normalise whatever is stored to a string list. */
export function refList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').slice(0, 500);
}

export interface AudienceMember {
  id: string;
  name: string;
  email: string;
}

/** Everyone an announcement is currently addressed to, as real user rows. */
export async function resolveAudience(audience: string, ref: string[]): Promise<AudienceMember[]> {
  const select = { id: true, name: true, email: true };
  const active = { status: 'active' as const };
  if (audience === 'user') {
    if (ref.length === 0) return [];
    return prisma.user.findMany({ where: { id: { in: ref } }, select });
  }
  if (audience === 'role') {
    if (ref.length === 0) return [];
    return prisma.user.findMany({ where: { ...active, role: { in: ref } }, select });
  }
  if (audience === 'plan') {
    if (ref.length === 0) return [];
    // Matched on the plan's stable key, so an announcement survives a rename.
    return prisma.user.findMany({ where: { ...active, plan: { key: { in: ref } } }, select });
  }
  return prisma.user.findMany({ where: active, select });
}

/** The other direction: does this one account fall inside the audience? */
export function matchesAudience(
  user: { id: string; role: string; plan_key: string | null },
  audience: string,
  ref: string[],
): boolean {
  if (audience === 'all') return true;
  if (audience === 'user') return ref.includes(user.id);
  if (audience === 'role') return ref.includes(user.role);
  if (audience === 'plan') return Boolean(user.plan_key && ref.includes(user.plan_key));
  return false;
}

export interface LiveAnnouncement {
  id: string;
  title: string;
  body: string;
  level: string;
  placement: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

/**
 * What this account should be shown right now. Only `banner` and `modal` are
 * returned: an `inbox` announcement is delivered as a Notification row and read
 * through the existing feed, so returning it here would show it twice.
 */
export async function liveAnnouncementsFor(userId: string): Promise<LiveAnnouncement[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, plan: { select: { key: true } } },
  });
  if (!user || user.status !== 'active') return [];

  const now = new Date();
  const rows = await prisma.announcement.findMany({
    where: {
      published: true,
      placement: { in: ['banner', 'modal'] },
      AND: [
        { OR: [{ starts_at: null }, { starts_at: { lte: now } }] },
        { OR: [{ ends_at: null }, { ends_at: { gte: now } }] },
      ],
    },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  const identity = { id: user.id, role: user.role, plan_key: user.plan?.key ?? null };
  return rows
    .filter((a) => matchesAudience(identity, a.audience, refList(a.audience_ref)))
    .map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      level: a.level,
      placement: a.placement,
      starts_at: a.starts_at ? a.starts_at.toISOString() : null,
      ends_at: a.ends_at ? a.ends_at.toISOString() : null,
      created_at: a.created_at.toISOString(),
    }));
}
