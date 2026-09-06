/**
 * Admin → Workspaces (spec §45, §47). Mounted at `/api/admin` beside the other
 * admin routers, behind the same chain and the same table-driven gate: the
 * `/workspaces` rule reads `workspaces.view` and writes `workspaces.manage`.
 *
 * A workspace is the unit everything else in the platform hangs off — projects,
 * environments and resources below it, billing and team beside it. The Users page
 * answers "who is this person"; this one answers "what does this account actually
 * contain, and who else can touch it".
 *
 * Two deliberate omissions:
 *
 *   - No plan or subscription mutation lives here. `plan_key` is written by the
 *     billing state machine after a verified payment, or by the audited override
 *     in `adminBilling` (§59). A second door onto the same column is how a
 *     "quick fix" ends up granting paid access with no payment behind it.
 *   - No resource controls. Stopping or deleting a customer's service belongs to
 *     the Applications page, which already owns that lifecycle; here a resource
 *     is a count and a name, so an operator can see the blast radius before
 *     touching the team.
 *
 * Everything a page shows is a count or a row from a real table. A workspace with
 * no projects renders an empty state rather than a plausible-looking number.
 */
import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { type AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { effectivePlanKey } from '../lib/billingState.js';

const router = Router();

/** Team roles an operator may assign. `owner` is a column on the workspace. */
const MEMBER_ROLES = ['admin', 'developer', 'viewer'] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];

/** "a developer" / "an admin" — the message reads back to the operator verbatim. */
function withArticle(role: string): string {
  return `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;
}

const EXPORT_ROW_CAP = 50_000;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Server-side paging (§42: "Do not load thousands of records at once"). */
function parsePaging(req: AuthenticatedRequest): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
  const pageSize = Math.min(
    200,
    Math.max(1, parseInt((req.query.pageSize as string) || '25', 10) || 25),
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** RFC-4180 CSV cell. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

/**
 * The operator's stated justification. §24 wants a reason on the record for a
 * change to somebody else's account, so this returns '' rather than a default —
 * the caller refuses, it never writes a reason on the admin's behalf.
 */
function reasonOf(req: AuthenticatedRequest): string {
  const raw = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  return raw.slice(0, 500);
}

const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
  plan_key: true,
  subscription_status: true,
  payment_status: true,
  billing_provider: true,
  current_period_end: true,
  manual_override: true,
  created_at: true,
  updated_at: true,
  owner: { select: { id: true, name: true, email: true, status: true, role: true } },
  _count: { select: { projects: true, members: true } },
} satisfies Prisma.WorkspaceSelect;

type ListRow = Prisma.WorkspaceGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * `?q=`, `?plan=`, `?status=` as a Prisma filter. `q` searches the workspace name
 * and id and the owner's name and email, because an operator arriving from a
 * support ticket has one of those four and no idea which.
 */
function listWhere(req: AuthenticatedRequest): Prisma.WorkspaceWhereInput {
  const where: Prisma.WorkspaceWhereInput = {};
  const q = (req.query.q as string)?.trim();
  if (q) {
    where.OR = [
      { name: { contains: q } },
      { id: { contains: q } },
      { email: { contains: q } },
      { owner: { is: { email: { contains: q } } } },
      { owner: { is: { name: { contains: q } } } },
    ];
  }
  const plan = (req.query.plan as string)?.trim();
  if (plan && plan !== 'all') where.plan_key = plan;

  const status = (req.query.status as string)?.trim();
  if (status && status !== 'all') where.subscription_status = status;

  return where;
}

/**
 * Resource counts for a page of workspaces, in one query.
 *
 * A `Project` (the deployable resource) points at a `WorkspaceProject`, not at
 * the workspace, so this cannot be a `_count` on the workspace select. Grouping
 * the intermediate table keeps it to a single round trip instead of one per row.
 */
async function resourceCounts(workspaceIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (workspaceIds.length === 0) return totals;

  const groups = await prisma.workspaceProject.findMany({
    where: { workspace_id: { in: workspaceIds } },
    select: { workspace_id: true, _count: { select: { resources: true } } },
  });
  for (const g of groups) {
    totals.set(g.workspace_id, (totals.get(g.workspace_id) ?? 0) + g._count.resources);
  }
  return totals;
}

function listRow(w: ListRow, resources: number) {
  return {
    id: w.id,
    name: w.name,
    // NULL means "use the owner's account email"; resolve it here so the table
    // never shows a blank cell that looks like missing data.
    email: w.email ?? w.owner.email,
    email_is_inherited: !w.email,
    avatar: w.avatar,
    plan_key: w.plan_key,
    /// What the workspace is entitled to *right now* — `plan_key` downgraded when
    /// the paid access has lapsed. The two differing is the interesting case.
    effective_plan_key: effectivePlanKey(w),
    subscription_status: w.subscription_status,
    payment_status: w.payment_status,
    billing_provider: w.billing_provider,
    current_period_end: w.current_period_end,
    manual_override: w.manual_override,
    owner: w.owner,
    projects: w._count.projects,
    members: w._count.members,
    resources,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

// ---------------------------------------------------------------------------
//  List
// ---------------------------------------------------------------------------

router.get('/workspaces', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, pageSize, skip } = parsePaging(req);
    const where = listWhere(req);

    const [rows, total] = await Promise.all([
      prisma.workspace.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
        select: LIST_SELECT,
      }),
      prisma.workspace.count({ where }),
    ]);

    const resources = await resourceCounts(rows.map((r) => r.id));

    // Filter vocabularies come from the data, so the UI never offers a plan or a
    // status that cannot match a single row.
    const [plans, statuses] = await Promise.all([
      prisma.workspace.groupBy({ by: ['plan_key'], _count: { _all: true } }),
      prisma.workspace.groupBy({ by: ['subscription_status'], _count: { _all: true } }),
    ]);

    res.json({
      workspaces: rows.map((w) => listRow(w, resources.get(w.id) ?? 0)),
      total,
      page,
      pageSize,
      facets: {
        plans: plans.map((p) => ({ key: p.plan_key, count: p._count._all })),
        statuses: statuses.map((s) => ({ key: s.subscription_status, count: s._count._all })),
      },
      member_roles: MEMBER_ROLES,
    });
  } catch (error) {
    console.error('[adminWorkspaces] list failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load workspaces.');
  }
});

// Static segment before `/:id`, or `export` is read as a workspace id.
router.get('/workspaces/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.workspace.findMany({
      where: listWhere(req),
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
      select: LIST_SELECT,
    });
    const resources = await resourceCounts(rows.map((r) => r.id));

    const csv = toCsv(
      [
        'id',
        'name',
        'owner_email',
        'owner_status',
        'plan_key',
        'effective_plan_key',
        'subscription_status',
        'payment_status',
        'projects',
        'resources',
        'members',
        'created_at',
      ],
      rows.map((w) => {
        const r = listRow(w, resources.get(w.id) ?? 0);
        return {
          id: r.id,
          name: r.name,
          owner_email: r.owner.email,
          owner_status: r.owner.status,
          plan_key: r.plan_key,
          effective_plan_key: r.effective_plan_key,
          subscription_status: r.subscription_status,
          payment_status: r.payment_status,
          projects: r.projects,
          resources: r.resources,
          members: r.members,
          created_at: r.created_at?.toISOString() ?? '',
        };
      }),
    );

    await writeAudit(req, 'admin.workspaces.export', {
      target_type: 'workspace',
      metadata: { rows: rows.length },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="workspaces.csv"');
    res.send(csv);
  } catch (error) {
    console.error('[adminWorkspaces] export failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not export workspaces.');
  }
});

// ---------------------------------------------------------------------------
//  Detail
// ---------------------------------------------------------------------------

router.get('/workspaces/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: {
        ...LIST_SELECT,
        manual_override_by: true,
        manual_override_reason: true,
        manual_override_at: true,
        current_period_start: true,
        cancel_at_period_end: true,
        subscription_id: true,
        members: {
          orderBy: [{ status: 'asc' }, { invited_at: 'asc' }],
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            invited_at: true,
            joined_at: true,
            user: { select: { id: true, name: true, email: true, status: true } },
          },
        },
        projects: {
          orderBy: { created_at: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            created_at: true,
            _count: { select: { resources: true, environments: true } },
            environments: {
              orderBy: { created_at: 'asc' },
              select: {
                id: true,
                name: true,
                is_default: true,
                _count: { select: { resources: true } },
              },
            },
          },
        },
        settings: {
          select: {
            pipeline_tier: true,
            deploy_policy: true,
            require_2fa: true,
            session_timeout_minutes: true,
            security_alerts: true,
            saml_enabled: true,
            scim_enabled: true,
            hipaa_enabled: true,
            hipaa_accepted_at: true,
          },
        },
      },
    });

    if (!workspace) {
      fail(res, 404, 'NOT_FOUND', 'No workspace with that id.');
      return;
    }

    // Resources listed by name rather than only counted: an operator deciding
    // whether a workspace is dormant needs to see what is actually in it.
    const resources = await prisma.project.findMany({
      where: { workspace_project_id: { in: workspace.projects.map((p) => p.id) } },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        project_type: true,
        status: true,
        domain: true,
        created_at: true,
        workspace_project_id: true,
        environment_id: true,
      },
    });

    res.json({
      workspace: {
        ...listRow(workspace, resources.length),
        manual_override_by: workspace.manual_override_by,
        manual_override_reason: workspace.manual_override_reason,
        manual_override_at: workspace.manual_override_at,
        current_period_start: workspace.current_period_start,
        cancel_at_period_end: workspace.cancel_at_period_end,
        subscription_id: workspace.subscription_id,
      },
      members: workspace.members,
      projects: workspace.projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        created_at: p.created_at,
        resources: p._count.resources,
        environments: p.environments.map((e) => ({
          id: e.id,
          name: e.name,
          is_default: e.is_default,
          resources: e._count.resources,
        })),
      })),
      resources,
      // NULL until the customer opens Workspace Settings; the page says so
      // rather than rendering defaults as though they had been chosen.
      settings: workspace.settings,
      member_roles: MEMBER_ROLES,
    });
  } catch (error) {
    console.error('[adminWorkspaces] detail failed:', error);
    fail(res, 500, 'INTERNAL', 'Could not load the workspace.');
  }
});

// ---------------------------------------------------------------------------
//  Mutations
// ---------------------------------------------------------------------------

router.patch('/workspaces/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) {
      fail(res, 400, 'REASON_REQUIRED', 'Editing a customer workspace needs a reason on the record.');
      return;
    }

    const before = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true },
    });
    if (!before) {
      fail(res, 404, 'NOT_FOUND', 'No workspace with that id.');
      return;
    }

    const data: Prisma.WorkspaceUpdateInput = {};

    if (req.body?.name !== undefined) {
      const name = String(req.body.name ?? '').trim();
      if (name.length < 2 || name.length > 100) {
        fail(res, 400, 'INVALID_NAME', 'A workspace name is between 2 and 100 characters.');
        return;
      }
      data.name = name;
    }

    if (req.body?.email !== undefined) {
      const raw = String(req.body.email ?? '').trim();
      // Empty clears the override back to "inherit the owner's account email",
      // which is a real state, not a missing value.
      if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        fail(res, 400, 'INVALID_EMAIL', 'That is not a valid billing email address.');
        return;
      }
      data.email = raw || null;
    }

    if (Object.keys(data).length === 0) {
      fail(res, 400, 'NOTHING_TO_DO', 'Send a name or an email to change.');
      return;
    }

    const after = await prisma.workspace.update({
      where: { id: before.id },
      data,
      select: { id: true, name: true, email: true },
    });

    await writeAudit(req, 'admin.workspace.update', {
      target_type: 'workspace',
      target_id: before.id,
      reason,
      before,
      after,
    });

    res.json({ success: true, workspace: after, message: 'Workspace updated.' });
  } catch (error) {
    console.error('[adminWorkspaces] update failed:', error);
    fail(res, 500, 'INTERNAL', 'The workspace was not updated.');
  }
});

router.patch('/workspaces/:id/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = reasonOf(req);
    if (!reason) {
      fail(res, 400, 'REASON_REQUIRED', "Changing a member's role needs a reason on the record.");
      return;
    }

    const role = String(req.body?.role ?? '').trim() as MemberRole;
    if (!MEMBER_ROLES.includes(role)) {
      fail(res, 400, 'INVALID_ROLE', `Role must be one of: ${MEMBER_ROLES.join(', ')}.`);
      return;
    }

    const member = await prisma.workspaceMember.findFirst({
      where: { id: req.params.memberId, workspace_id: req.params.id },
      select: {
        id: true,
        email: true,
        role: true,
        user_id: true,
        workspace: { select: { id: true, owner_id: true } },
      },
    });
    if (!member) {
      fail(res, 404, 'NOT_FOUND', 'No such member in this workspace.');
      return;
    }

    // The owner's authority comes from `Workspace.owner_id`, not from a row in
    // this table. Demoting their membership row would leave the workspace
    // looking leaderless while changing nothing about what they can do.
    if (member.user_id && member.user_id === member.workspace.owner_id) {
      fail(res, 409, 'OWNER_IMMUTABLE', 'The workspace owner’s role is set by ownership, not membership.');
      return;
    }

    if (member.role === role) {
      res.json({ success: true, message: `${member.email} is already ${withArticle(role)}.` });
      return;
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role },
      select: { id: true, email: true, role: true, status: true },
    });

    await writeAudit(req, 'admin.workspace.member.role', {
      target_type: 'workspace',
      target_id: member.workspace.id,
      reason,
      before: { member: member.email, role: member.role },
      after: { member: updated.email, role: updated.role },
    });

    res.json({ success: true, member: updated, message: `${updated.email} is now ${withArticle(role)}.` });
  } catch (error) {
    console.error('[adminWorkspaces] member role change failed:', error);
    fail(res, 500, 'INTERNAL', 'The role was not changed.');
  }
});

router.delete('/workspaces/:id/members/:memberId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // DELETE carries no body in some clients, so the reason may arrive as a query
    // parameter. Both are accepted; neither being present is refused.
    const reason = reasonOf(req) || String(req.query.reason ?? '').trim().slice(0, 500);
    if (!reason) {
      fail(res, 400, 'REASON_REQUIRED', 'Removing a member needs a reason on the record.');
      return;
    }

    const member = await prisma.workspaceMember.findFirst({
      where: { id: req.params.memberId, workspace_id: req.params.id },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        user_id: true,
        workspace: { select: { id: true, name: true, owner_id: true } },
      },
    });
    if (!member) {
      fail(res, 404, 'NOT_FOUND', 'No such member in this workspace.');
      return;
    }

    // Removing the owner would orphan every project in the workspace and leave
    // billing pointing at an account with no way back in. Ownership transfer is
    // a different, deliberate action — not a side effect of a delete button.
    if (member.user_id && member.user_id === member.workspace.owner_id) {
      fail(res, 409, 'OWNER_IMMUTABLE', 'The workspace owner cannot be removed from their own workspace.');
      return;
    }

    await prisma.workspaceMember.delete({ where: { id: member.id } });

    await writeAudit(req, 'admin.workspace.member.remove', {
      target_type: 'workspace',
      target_id: member.workspace.id,
      reason,
      before: { member: member.email, role: member.role, status: member.status },
      after: null,
    });

    res.json({
      success: true,
      message: `${member.email} no longer has access to ${member.workspace.name}.`,
    });
  } catch (error) {
    console.error('[adminWorkspaces] member removal failed:', error);
    fail(res, 500, 'INTERNAL', 'The member was not removed.');
  }
});

export default router;
