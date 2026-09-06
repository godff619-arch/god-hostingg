// Admin Workspace Detail (/admin/workspaces/:id) — §45, §47, §52.
//
// Everything one customer account contains, on one page: the projects and their
// environments, the resources deployed inside them, and the people who can reach
// any of it.
//
// Two write actions live here, both audited with a mandatory reason: rename the
// workspace (or change its billing email), and manage a team member's role or
// access. Neither is a convenience — support is regularly asked "remove the
// contractor we let go", and doing that from the database by hand leaves no record
// of who asked or why.
//
// The owner is deliberately immutable from this page. Their authority comes from
// `Workspace.owner_id`, not from a membership row, so demoting or removing that
// row would change the display without changing what they can do — and removing
// the real owner would orphan every project below. The server refuses both; the
// UI explains rather than silently hiding the buttons.
//
// Billing is read-only here and links to the pages that own it. Changing what a
// workspace pays for is the §59 override on Subscriptions, which records a reason
// and does not fabricate a payment.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Boxes,
  CreditCard,
  Layers,
  Loader2,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DetailRow,
  Field,
  ListEmpty,
  ListError,
  Metric,
  MetricStrip,
  SelectBox,
  ToneBadge,
} from "@/components/admin/AdminList";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet, adminSend } from "@/lib/adminApi";
import type {
  WorkspaceDetailResponse,
  WorkspaceMemberRow,
  WorkspaceResourceRow,
} from "@/lib/adminWorkspaceTypes";
import { billingTone, formatDate, formatDateTime, humanize } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

export default function AdminWorkspaceDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAdminMe();
  const canManage = can("workspaces.manage");

  const [data, setData] = useState<WorkspaceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("projects");
  const [editing, setEditing] = useState(false);
  const [memberEdit, setMemberEdit] = useState<WorkspaceMemberRow | null>(null);
  const [memberRemove, setMemberRemove] = useState<WorkspaceMemberRow | null>(null);

  /**
   * The full-page skeleton is only for the first load. Re-reading after a member
   * change used to unmount the tabs and drop the operator back on Projects — they
   * clicked Remove on the Team tab and the page moved out from under them.
   *
   * A ref rather than reading `data`, so `load` keeps a stable identity and the
   * effect below does not re-fire every time the response lands.
   */
  const loaded = useRef(false);
  const load = useCallback(async () => {
    if (!id) return;
    if (loaded.current) setRefreshing(true);
    else setLoading(true);
    try {
      setData(await adminGet<WorkspaceDetailResponse>(`/workspaces/${id}`));
      loaded.current = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the workspace");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /** Resources keyed by environment, so each environment lists its own. */
  const byEnvironment = useMemo(() => {
    const map = new Map<string, WorkspaceResourceRow[]>();
    for (const r of data?.resources ?? []) {
      const key = r.environment_id ?? "none";
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <ListError message={error || "Workspace not found"} onRetry={load} />
        <Button asChild variant="outline">
          <Link to="/admin/workspaces">
            <ArrowLeft className="h-4 w-4" /> Back to workspaces
          </Link>
        </Button>
      </div>
    );
  }

  const ws = data.workspace;
  const lapsed = ws.plan_key !== ws.effective_plan_key;

  return (
    <>
      <PageHeader
        title={ws.name}
        description={`Owned by ${ws.owner.name || ws.owner.email}`}
        icon={Boxes}
        eyebrow={ws.id}
        actions={
          <div className="flex items-center gap-2">
            {canManage && (
              <Button
                variant="outline"
                onClick={() => setEditing(true)}
                className="h-10 border-border/60 bg-background"
              >
                <Pencil className="h-4 w-4" />
                <span className="hidden sm:inline">Edit</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              title="Refresh"
              className="h-10 w-10 border-border/60 bg-background"
            >
              <RefreshCw className={cn("h-4 w-4 text-muted-foreground", refreshing && "animate-spin")} />
            </Button>
            <Button asChild variant="outline" className="h-10 border-border/60">
              <Link to="/admin/workspaces">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Back</span>
              </Link>
            </Button>
          </div>
        }
        meta={
          <>
            <ToneBadge label={humanize(ws.plan_key)} tone={lapsed ? "neutral" : "info"} />
            {lapsed && (
              <ToneBadge
                label={`served as ${humanize(ws.effective_plan_key)}`}
                tone="warning"
                title="The paid plan is not live, so free-plan limits are being applied."
              />
            )}
            <ToneBadge
              label={humanize(ws.subscription_status)}
              tone={billingTone(ws.subscription_status)}
            />
            {ws.manual_override && <ToneBadge label="Manual override" tone="info" />}
          </>
        }
      />

      <MetricStrip>
        <Metric label="Projects" value={data.projects.length} hint="Groups of environments" />
        <Metric
          label="Resources"
          value={data.resources.length}
          hint={data.resources.length >= 100 ? "First 100 shown" : "Services and databases"}
        />
        <Metric label="Team" value={data.members.length} hint="Members, including invites" />
        <Metric
          label="Created"
          value={formatDate(ws.created_at)}
          hint={`Last change ${formatDate(ws.updated_at)}`}
        />
      </MetricStrip>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="projects" className="gap-1.5">
            <Layers className="h-3.5 w-3.5" /> Projects
            <CountPill n={data.projects.length} />
          </TabsTrigger>
          <TabsTrigger value="team" className="gap-1.5">
            <Users className="h-3.5 w-3.5" /> Team
            <CountPill n={data.members.length} />
          </TabsTrigger>
          <TabsTrigger value="billing" className="gap-1.5">
            <CreditCard className="h-3.5 w-3.5" /> Billing
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------------------ */}
        <TabsContent value="projects" className="space-y-3">
          {data.projects.length === 0 ? (
            <ListEmpty
              message="This workspace has no projects."
              hint="A project appears as soon as the customer creates one; resources are deployed inside its environments."
            />
          ) : (
            data.projects.map((project) => (
              <section
                key={project.id}
                className="overflow-hidden rounded-2xl border border-border/60 bg-card"
              >
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/40 bg-secondary/20 px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{project.name}</h3>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {project.description || `Created ${formatDate(project.created_at)}`}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {project.resources} resource{project.resources === 1 ? "" : "s"} ·{" "}
                    {project.environments.length} environment
                    {project.environments.length === 1 ? "" : "s"}
                  </span>
                </header>

                {project.environments.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No environments yet.
                  </p>
                ) : (
                  <div className="divide-y divide-border/40">
                    {project.environments.map((env) => {
                      const resources = byEnvironment.get(env.id) ?? [];
                      return (
                        <div key={env.id} className="px-4 py-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{env.name}</span>
                            {env.is_default && <ToneBadge label="Default" tone="info" />}
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {env.resources} resource{env.resources === 1 ? "" : "s"}
                            </span>
                          </div>
                          {resources.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {env.resources === 0
                                ? "Nothing deployed here."
                                : "Not in the first 100 resources shown."}
                            </p>
                          ) : (
                            <ul className="flex flex-wrap gap-1.5">
                              {resources.map((r) => (
                                <li
                                  key={r.id}
                                  className="flex min-w-0 items-center gap-1.5 rounded-xl border border-border/60 bg-background px-2.5 py-1.5 text-xs"
                                  title={r.domain ?? undefined}
                                >
                                  <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="max-w-[10rem] truncate font-medium">{r.name}</span>
                                  {r.status && (
                                    <span
                                      className={cn(
                                        "text-[10px] uppercase tracking-wide",
                                        r.status === "running" ? "text-success" : "text-muted-foreground",
                                      )}
                                    >
                                      {r.status}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ))
          )}
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        <TabsContent value="team">
          <div className="overflow-hidden rounded-2xl border border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 bg-secondary/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                The owner is listed first and cannot be changed here — their access comes from
                owning the workspace, not from a membership row.
              </p>
            </div>

            <ul className="divide-y divide-border/40 stagger-in">
              <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {ws.owner.name || ws.owner.email}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {ws.owner.email}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <ToneBadge label="Owner" tone="info" />
                  {ws.owner.status !== "active" && (
                    <ToneBadge label={humanize(ws.owner.status)} tone="danger" />
                  )}
                  <Button asChild variant="ghost" size="sm" className="h-8">
                    <Link to={`/admin/users/${ws.owner.id}`}>Open account</Link>
                  </Button>
                </span>
              </li>

              {data.members
                .filter((m) => m.user?.id !== ws.owner.id)
                .map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">
                        {m.user?.name || m.email}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {m.email}
                        {m.status === "invited"
                          ? ` · invited ${formatDate(m.invited_at)}`
                          : m.joined_at
                            ? ` · joined ${formatDate(m.joined_at)}`
                            : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ToneBadge label={humanize(m.role)} />
                      {m.status === "invited" && (
                        <ToneBadge
                          label="Invite pending"
                          tone="warning"
                          title="No account has registered with this address yet."
                        />
                      )}
                      {canManage && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            onClick={() => setMemberEdit(m)}
                          >
                            <Pencil className="h-3.5 w-3.5" /> Role
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-danger hover:text-danger"
                            onClick={() => setMemberRemove(m)}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
            </ul>

            {data.members.filter((m) => m.user?.id !== ws.owner.id).length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                Nobody else has been invited to this workspace.
              </p>
            )}
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        <TabsContent value="billing" className="space-y-4">
          <Panel title="Subscription">
            <DetailRow label="Plan on file">{humanize(ws.plan_key)}</DetailRow>
            <DetailRow label="Currently honoured">
              <span className={cn(lapsed && "font-semibold text-warning")}>
                {humanize(ws.effective_plan_key)}
              </span>
            </DetailRow>
            <DetailRow label="Subscription status">
              <ToneBadge
                label={humanize(ws.subscription_status)}
                tone={billingTone(ws.subscription_status)}
              />
            </DetailRow>
            <DetailRow label="Payment status">
              <ToneBadge
                label={humanize(ws.payment_status)}
                tone={billingTone(ws.payment_status)}
              />
            </DetailRow>
            <DetailRow label="Provider">
              {ws.billing_provider ? humanize(ws.billing_provider) : "None"}
            </DetailRow>
            <DetailRow label="Current period">
              {ws.current_period_start || ws.current_period_end
                ? `${formatDate(ws.current_period_start)} → ${formatDate(ws.current_period_end)}`
                : "No billing period recorded"}
            </DetailRow>
            <DetailRow label="Cancels at period end">
              {ws.cancel_at_period_end ? "Yes" : "No"}
            </DetailRow>
            <DetailRow label="Billing email">
              {ws.email}
              {ws.email_is_inherited && (
                <span className="ml-1.5 text-xs text-muted-foreground">(owner’s address)</span>
              )}
            </DetailRow>
          </Panel>

          {ws.manual_override && (
            <Panel title="Manual override">
              <DetailRow label="Set by">{ws.manual_override_by || "—"}</DetailRow>
              <DetailRow label="When">{formatDateTime(ws.manual_override_at)}</DetailRow>
              <DetailRow label="Reason">
                {ws.manual_override_reason || "No reason recorded"}
              </DetailRow>
            </Panel>
          )}

          <p className="rounded-2xl border border-border/60 bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
            Plans are changed from{" "}
            <Link to="/admin/subscriptions" className="font-medium text-brand hover:underline">
              Subscriptions
            </Link>
            , where the override records a reason and does not create a payment. Charges and
            refunds live on{" "}
            <Link to="/admin/payments" className="font-medium text-brand hover:underline">
              Payments
            </Link>
            .
          </p>

          <Panel title="Workspace settings">
            {data.settings ? (
              <>
                <DetailRow label="Pipeline tier">{humanize(data.settings.pipeline_tier)}</DetailRow>
                <DetailRow label="Deploy policy">{humanize(data.settings.deploy_policy)}</DetailRow>
                <DetailRow label="Two-factor required">
                  {data.settings.require_2fa ? "Yes" : "No"}
                </DetailRow>
                <DetailRow label="Session timeout">
                  {data.settings.session_timeout_minutes
                    ? `${data.settings.session_timeout_minutes} minutes`
                    : "Platform default"}
                </DetailRow>
                <DetailRow label="Security alerts">
                  {data.settings.security_alerts ? "On" : "Off"}
                </DetailRow>
                <DetailRow label="SAML / SCIM">
                  {`${data.settings.saml_enabled ? "SAML on" : "SAML off"} · ${
                    data.settings.scim_enabled ? "SCIM on" : "SCIM off"
                  }`}
                </DetailRow>
                <DetailRow label="HIPAA">
                  {data.settings.hipaa_enabled
                    ? `Accepted ${formatDate(data.settings.hipaa_accepted_at)}`
                    : "Not enabled"}
                </DetailRow>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                This workspace has never opened its settings, so nothing has been chosen — the
                platform defaults apply.
              </p>
            )}
          </Panel>
        </TabsContent>
      </Tabs>

      {editing && (
        <EditWorkspaceDialog
          workspaceId={ws.id}
          initialName={ws.name}
          initialEmail={ws.email_is_inherited ? "" : ws.email}
          ownerEmail={ws.owner.email}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}

      {memberEdit && (
        <MemberRoleDialog
          workspaceId={ws.id}
          member={memberEdit}
          roles={data.member_roles}
          onClose={() => setMemberEdit(null)}
          onSaved={() => {
            setMemberEdit(null);
            load();
          }}
        />
      )}

      {memberRemove && (
        <MemberRemoveDialog
          workspaceId={ws.id}
          workspaceName={ws.name}
          member={memberRemove}
          onClose={() => setMemberRemove(null)}
          onRemoved={() => {
            setMemberRemove(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** "an admin" / "a developer" — the sentence is read back to the operator. */
function withArticle(role: string): string {
  return `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`;
}

function CountPill({ n }: { n: number }) {  if (n === 0) return null;
  return (
    <span className="rounded-full bg-secondary px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card px-4 py-3">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Rename, or point billing at a different address.
 *
 * The reason is required by the server, not only by this form (§24) — an operator
 * editing somebody else's account leaves a record of why, or the edit does not
 * happen.
 */
function EditWorkspaceDialog({
  workspaceId,
  initialName,
  initialEmail,
  ownerEmail,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initialName: string;
  initialEmail: string;
  ownerEmail: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const changed = name.trim() !== initialName || email.trim() !== initialEmail;

  const submit = async () => {
    setSaving(true);
    try {
      const res = await adminSend<{ message: string }>(`/workspaces/${workspaceId}`, "PATCH", {
        name: name.trim(),
        email: email.trim(),
        reason: reason.trim(),
      });
      toast.success(res.message || "Workspace updated.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The workspace was not updated.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit workspace</DialogTitle>
          <DialogDescription>
            The customer sees both of these. The change is written to the audit log with your name
            and your reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Billing email"
            hint={`Leave blank to use the owner's address (${ownerEmail}).`}
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={ownerEmail}
            />
          </Field>
          <Field label="Reason" hint="Required. Stored on the audit record.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Renamed at the customer's request, ticket #412"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !changed || name.trim().length < 2 || reason.trim().length === 0}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRoleDialog({
  workspaceId,
  member,
  roles,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  member: WorkspaceMemberRow;
  roles: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await adminSend<{ message: string }>(
        `/workspaces/${workspaceId}/members/${member.id}`,
        "PATCH",
        { role, reason: reason.trim() },
      );
      toast.success(res.message || "Role changed.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The role was not changed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            {member.email} is currently {withArticle(humanize(member.role).toLowerCase())} in this
            workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Role" hint="Takes effect on their next request.">
            <SelectBox value={role} onChange={setRole}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </SelectBox>
          </Field>
          <Field label="Reason" hint="Required. Stored on the audit record.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Promoted to admin at the owner's request"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || role === member.role || reason.trim().length === 0}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Change role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRemoveDialog({
  workspaceId,
  workspaceName,
  member,
  onClose,
  onRemoved,
}: {
  workspaceId: string;
  workspaceName: string;
  member: WorkspaceMemberRow;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      // The reason travels in the query string: `fetch` with a DELETE body is
      // legal but several proxies drop it, and losing it here would mean an audit
      // record with no justification on it.
      const res = await adminSend<{ message: string }>(
        `/workspaces/${workspaceId}/members/${member.id}?reason=${encodeURIComponent(reason.trim())}`,
        "DELETE",
      );
      toast.success(res.message || "Member removed.");
      onRemoved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The member was not removed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {member.email}?</DialogTitle>
          <DialogDescription>
            They lose access to {workspaceName} and everything deployed in it. Nothing they created
            is deleted, and the owner can invite them again.
          </DialogDescription>
        </DialogHeader>

        <Field label="Reason" hint="Required. Stored on the audit record.">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Left the company, requested by the owner"
            autoFocus
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={saving || reason.trim().length === 0}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Remove access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
