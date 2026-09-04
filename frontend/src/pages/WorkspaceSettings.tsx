// Workspace Settings — spec Part C §41–§60.
//
// Everything here is the logged-in user's real workspace: the id in the header is
// the actual `tea-` row id, the plan badge is `workspace.plan_key`, and each gated
// section renders the tier the *server* says it needs (`feature_tiers`) rather than
// a hardcoded "needs Pro". Writes go through `PATCH /api/workspace/settings`, which
// re-checks every gate — the gating below is presentation only.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlanBadge, PlanLockedCard } from "@/components/workspace/PlanGate";
import { TocLayout, TocSection, type TocItem } from "@/components/workspace/PageToc";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import {
  apiDownload,
  apiGet,
  apiSend,
  errorMessage,
  scoped,
  setActiveWorkspaceId,
} from "@/lib/workspaceApi";
import { cn, copyToClipboard } from "@/lib/utils";
import type {
  AuditLogsPayload,
  MemberRow,
  PipelineTier,
  RegistryCredentialsPayload,
  WorkspaceRole,
  WorkspaceSettingsPayload,
} from "@/lib/workspaceTypes";

/**
 * Scopes every request on this page to the workspace being viewed:
 * `/workspace/:workspaceId/settings` targets the URL's workspace,
 * `/workspace/settings` the one selected in the header switcher. Mutations read
 * this so they can never land on a different workspace than the data shown.
 */
const ScopeCtx = createContext<(path: string) => string>(scoped);

function useScope(): (path: string) => string {
  return useContext(ScopeCtx);
}

const SECTIONS: TocItem[] = [
  { id: "general", label: "General" },
  { id: "team-members", label: "Team Members" },
  { id: "build-pipeline", label: "Build Pipeline" },
  { id: "deploy-policy", label: "Deploy Policy" },
  { id: "registry-credentials", label: "Registry Credentials" },
  { id: "security", label: "Security" },
  { id: "authentication", label: "Authentication" },
  { id: "hipaa", label: "HIPAA Compliance" },
  { id: "audit-logs", label: "Audit Logs" },
  { id: "documents", label: "Documents" },
  { id: "delete-workspace", label: "Delete Workspace" },
];

/** Integer cents → `$25.00`. The client formats money, it never computes it. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function stampLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function WorkspaceSettings() {
  const { workspaceId } = useParams();
  const { refresh: refreshWorkspace, canWrite } = useWorkspace();
  const [data, setData] = useState<WorkspaceSettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scope = useMemo<(path: string) => string>(
    () =>
      workspaceId
        ? (path: string) =>
            `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`
        : scoped,
    [workspaceId],
  );

  const path = useMemo(() => scope("/api/workspace/settings"), [scope]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<WorkspaceSettingsPayload>(path));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  // A rename changes the header avatar and switcher too, so both are refreshed.
  const reload = useCallback(async () => {
    await load();
    await refreshWorkspace();
  }, [load, refreshWorkspace]);

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-[1160px] space-y-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-secondary/50" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-md border border-border bg-card" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        <div className="rounded-md border border-danger-border bg-danger-surface p-4 text-[13px] text-danger">
          {error ?? "Could not load workspace settings."}
        </div>
        <Button variant="outline" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="mx-auto mb-6 w-full max-w-[1160px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[27px] font-medium leading-tight text-foreground">Settings</h1>
            <PlanBadge tier={data.plan.key} />
          </div>
          <Button
            variant="bare"
            size="icon"
            aria-label="Refresh settings"
            onClick={() => void reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
        </div>
        {/* The real row id, not the screenshot's (§81). */}
        <WorkspaceIdRow id={data.workspace.id} />
      </div>

      <TocLayout sections={SECTIONS}>
        <ScopeCtx.Provider value={scope}>
          <div className="space-y-8 pb-16">
            {error ? (
              <div className="rounded-md border border-danger-border bg-danger-surface p-3 text-[12px] text-danger">
                {error}
              </div>
            ) : null}

            <GeneralSection data={data} canWrite={canWrite} onChanged={reload} />
            <TeamMembersSection role={data.role} canWrite={canWrite} />
            <BuildPipelineSection data={data} canWrite={canWrite} onChanged={reload} />
            <DeployPolicySection data={data} canWrite={canWrite} onChanged={reload} />
            <RegistryCredentialsSection canWrite={canWrite} />
            <SecuritySection data={data} canWrite={canWrite} onChanged={reload} />
            <AuthenticationSection data={data} canWrite={canWrite} onChanged={reload} />
            <HipaaSection data={data} canWrite={canWrite} onChanged={reload} />
            <AuditLogsSection />
            <DocumentsSection data={data} />
            <DeleteWorkspaceSection data={data} />
          </div>
        </ScopeCtx.Provider>
      </TocLayout>
    </div>
  );
}

/** `Workspace ID: tea-xxxx` with a copy button (§42). */
function WorkspaceIdRow({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyToClipboard(id))) {
      toast.error("Could not copy the workspace ID");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
      <span>Workspace ID:</span>
      <code className="font-mono text-[12px] text-foreground">{id}</code>
      <Button variant="bare" size="icon" aria-label="Copy workspace ID" onClick={() => void copy()}>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" strokeWidth={1.75} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
        )}
      </Button>
    </div>
  );
}

/** Plain bordered panel — the one card shape used by every section here. */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-md border border-border bg-card p-4", className)}>{children}</div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[12px] text-muted-foreground">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Checkbox row. There is no checkbox primitive in `ui/`, so this is the pattern. */
function ToggleRow({
  checked,
  onChange,
  disabled,
  title,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5",
        disabled ? "opacity-60" : "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

/**
 * Saves a partial settings patch. Only the fields a section owns are sent, so two
 * sections can never overwrite each other's values, and a `PLAN_LOCKED` refusal
 * from the server surfaces as the toast the user sees.
 */
function useSettingsSave(onChanged: () => Promise<void>) {
  const scope = useScope();
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (patch: Record<string, unknown>, message: string): Promise<boolean> => {
      setSaving(true);
      try {
        await apiSend(scope("/api/workspace/settings"), "PATCH", patch);
        toast.success(message);
        await onChanged();
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onChanged, scope],
  );

  return { saving, save };
}

/** Read-only sections still need to explain *why* they are read-only. */
function ViewerNote({ canWrite }: { canWrite: boolean }) {
  if (canWrite) return null;
  return (
    <p className="mt-3 text-[11px] text-muted-foreground">
      Your workspace role can view these settings but not change them.
    </p>
  );
}

// ------------------------------------------------------------------ General (§42)

function GeneralSection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const scope = useScope();
  const [name, setName] = useState(data.workspace.name);
  const [email, setEmail] = useState(data.workspace.email ?? "");
  const [saving, setSaving] = useState(false);

  // Re-seed when the server's copy changes so a refresh wins over stale input.
  useEffect(() => {
    setName(data.workspace.name);
    setEmail(data.workspace.email ?? "");
  }, [data.workspace.name, data.workspace.email]);

  const dirty = name.trim() !== data.workspace.name || email.trim() !== (data.workspace.email ?? "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || !name.trim()) return;
    setSaving(true);
    try {
      await apiSend(scope("/api/workspace"), "PATCH", { name: name.trim(), email: email.trim() });
      toast.success("Workspace updated");
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <TocSection
      id="general"
      title="General"
      description="The workspace name is shown in the header switcher and on invitations."
    >
      <Panel>
        <div className="flex items-center gap-3">
          {/* Avatar is the first letter of the name (§43) unless one was uploaded. */}
          {data.workspace.avatar ? (
            <img
              src={data.workspace.avatar}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-[15px] font-semibold text-brand-foreground">
              {data.workspace.initial}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-foreground">
              {data.workspace.name}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Created {dateLabel(data.workspace.created_at)} · {data.member_count}{" "}
              {data.member_count === 1 ? "member" : "members"}
            </div>
          </div>
        </div>

        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={submit}>
          <Field label="Workspace name" htmlFor="ws-name">
            <Input
              id="ws-name"
              value={name}
              maxLength={60}
              disabled={!canWrite}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Billing email"
            htmlFor="ws-email"
            hint="Left blank, invoices go to the workspace owner's account email."
          >
            <Input
              id="ws-email"
              type="email"
              value={email}
              disabled={!canWrite}
              placeholder="billing@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <div className="md:col-span-2">
            <Button type="submit" size="sm" disabled={!canWrite || !dirty || saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save changes
            </Button>
          </div>
        </form>
        <ViewerNote canWrite={canWrite} />
      </Panel>
    </TocSection>
  );
}

// ------------------------------------------------------------- Team Members (§44)

const ASSIGNABLE_ROLES: WorkspaceRole[] = ["admin", "developer", "viewer"];

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  developer: "Developer",
  viewer: "Viewer",
};

function TeamMembersSection({ role, canWrite }: { role: WorkspaceRole; canWrite: boolean }) {
  const scope = useScope();
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);

  const path = useMemo(() => scope("/api/workspace/members"), [scope]);

  const load = useCallback(async () => {
    try {
      const payload = await apiGet<{ members: MemberRow[] }>(path);
      setMembers(payload.members);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (member: MemberRow, next: WorkspaceRole) => {
    try {
      await apiSend(`/api/workspace/members/${member.id}`, "PATCH", { role: next });
      toast.success(`${member.email} is now ${ROLE_LABEL[next].toLowerCase()}`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <TocSection
      id="team-members"
      title="Team Members"
      description="Admins manage the workspace, developers deploy, viewers can only read."
      action={
        canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Invite
          </Button>
        ) : null
      }
    >
      {error ? (
        <div className="rounded-md border border-danger-border bg-danger-surface p-3 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-secondary/30">
              {["Member", "Role", "Status", ""].map((head, i) => (
                <th
                  key={head || i}
                  className="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members === null ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-[12px] text-muted-foreground">
                  Loading members…
                </td>
              </tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-[12px] text-muted-foreground">
                  No team members yet.
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2.5">
                    <div className="text-[13px] text-foreground">{member.email}</div>
                    {member.name ? (
                      <div className="text-[11px] text-muted-foreground">{member.name}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    {member.is_owner ? (
                      <span className="text-[12px] text-muted-foreground">Owner</span>
                    ) : (
                      <select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={!canWrite}
                        onChange={(e) => void changeRole(member, e.target.value as WorkspaceRole)}
                        className="h-8 rounded-md border border-border bg-transparent px-2 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring disabled:opacity-60"
                      >
                        {ASSIGNABLE_ROLES.map((option) => (
                          <option key={option} value={option} className="bg-card">
                            {ROLE_LABEL[option]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "text-[12px]",
                        member.status === "active" ? "text-success" : "text-muted-foreground",
                      )}
                    >
                      {member.status === "active"
                        ? `Active${member.joined_at ? ` · joined ${dateLabel(member.joined_at)}` : ""}`
                        : "Invited"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {member.is_owner ? null : (
                      <Button
                        variant="bare"
                        size="icon"
                        aria-label={`Remove ${member.email}`}
                        disabled={!canWrite}
                        onClick={() => setRemoving(member)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ViewerNote canWrite={canWrite} />
      {role === "owner" ? null : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          The workspace owner cannot be removed or have their role changed.
        </p>
      )}

      <InviteDialog open={inviting} onOpenChange={setInviting} onDone={load} />
      {removing ? (
        <RemoveMemberDialog
          member={removing}
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          onDone={load}
        />
      ) : null}
    </TocSection>
  );
}

/** Invite by email. Several addresses at once, one role for the batch. */
function InviteDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("developer");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRaw("");
    setRole("developer");
  }, [open]);

  const emails = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (emails.length === 0) return;
    setSaving(true);
    try {
      const result = await apiSend<{ invited: number; total: number }>(
        scope("/api/workspace/members"),
        "POST",
        { emails, role },
      );
      toast.success(
        result.invited === result.total
          ? `Invited ${result.invited} ${result.invited === 1 ? "person" : "people"}`
          : `${result.invited} invited, ${result.total - result.invited} already on the team`,
      );
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Invite to workspace</DialogTitle>
            <DialogDescription>
              One address per line. Everyone in this batch gets the same role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Field label="Email addresses" htmlFor="invite-emails">
              <Textarea
                id="invite-emails"
                rows={4}
                value={raw}
                placeholder={"teammate@example.com\nanother@example.com"}
                onChange={(e) => setRaw(e.target.value)}
              />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as WorkspaceRole)}
                className="h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
              >
                {ASSIGNABLE_ROLES.map((option) => (
                  <option key={option} value={option} className="bg-card">
                    {ROLE_LABEL[option]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={emails.length === 0 || saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Send {emails.length > 0 ? `${emails.length} ` : ""}invite
              {emails.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Destructive, so it is confirmed (§77) and names the person being removed. */
function RemoveMemberDialog({
  member,
  open,
  onOpenChange,
  onDone,
}: {
  member: MemberRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await apiSend(`/api/workspace/members/${member.id}`, "DELETE");
      toast.success(`${member.email} removed`);
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {member.email}?</DialogTitle>
          <DialogDescription>
            They lose access to this workspace and everything in it immediately. Resources they
            created are not deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Remove member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ Build Pipeline (§45)

function BuildPipelineSection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { saving, save } = useSettingsSave(onChanged);
  const [tier, setTier] = useState(data.settings.pipeline_tier);
  // Kept as dollars in the input and converted on save — the wire is always cents.
  const [limit, setLimit] = useState(
    data.settings.pipeline_spend_limit_cents === null
      ? ""
      : (data.settings.pipeline_spend_limit_cents / 100).toFixed(2),
  );

  useEffect(() => {
    setTier(data.settings.pipeline_tier);
    setLimit(
      data.settings.pipeline_spend_limit_cents === null
        ? ""
        : (data.settings.pipeline_spend_limit_cents / 100).toFixed(2),
    );
  }, [data.settings.pipeline_tier, data.settings.pipeline_spend_limit_cents]);

  const parsedLimit = limit.trim() === "" ? null : Math.round(Number(limit) * 100);
  const limitInvalid = parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit < 0);
  const dirty =
    tier !== data.settings.pipeline_tier ||
    parsedLimit !== data.settings.pipeline_spend_limit_cents;

  /** A tier is selectable only when the plan carries the feature it names. */
  const allowed = (option: PipelineTier): boolean =>
    option.requires === null || data.features[option.requires];

  const apply = () =>
    void save(
      { pipeline_tier: tier, pipeline_spend_limit_cents: parsedLimit },
      "Build pipeline updated",
    );

  return (
    <TocSection
      id="build-pipeline"
      title="Build Pipeline"
      description="The machine size used to build this workspace's services, and an optional monthly cap on build spend."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {data.pipeline_tiers.map((option) => {
          const selected = option.key === tier;
          const locked = !allowed(option);
          return (
            <button
              key={option.key}
              type="button"
              disabled={locked || !canWrite}
              onClick={() => setTier(option.key)}
              className={cn(
                "rounded-md border p-4 text-left transition-colors",
                selected ? "border-brand-strong bg-brand/20" : "border-border bg-card",
                locked || !canWrite ? "cursor-not-allowed opacity-70" : "hover:bg-hover",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-medium text-foreground">{option.name}</span>
                {locked && option.requires ? (
                  <PlanBadge tier={data.feature_tiers[option.requires]} />
                ) : selected ? (
                  <Check className="h-3.5 w-3.5 text-success" strokeWidth={2} />
                ) : null}
              </div>
              <div className="mt-1 text-[17px] font-medium text-foreground">
                {money(option.rate_cents_per_1000_min)}
                <span className="text-[12px] font-normal text-muted-foreground">
                  {" "}
                  / 1,000 minutes
                </span>
              </div>
              <div className="mt-2 text-[12px] text-muted-foreground">
                {option.cpu} CPU · {option.memory_gb} GB RAM
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {option.free_minutes > 0
                  ? `${option.free_minutes.toLocaleString()} free minutes each month`
                  : "No free minutes included"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 max-w-[320px]">
        <Field
          label="Monthly spend limit"
          htmlFor="pipeline-limit"
          hint="Leave blank for no cap. Builds stop once the limit is reached."
        >
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted-foreground">$</span>
            <Input
              id="pipeline-limit"
              inputMode="decimal"
              value={limit}
              disabled={!canWrite}
              placeholder="No limit"
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>
        </Field>
        {limitInvalid ? (
          <p className="mt-1.5 text-[11px] text-danger">Enter an amount of 0 or more.</p>
        ) : null}
      </div>

      <Button
        size="sm"
        className="mt-4"
        disabled={!canWrite || !dirty || limitInvalid || saving}
        onClick={apply}
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Save pipeline settings
      </Button>
      <ViewerNote canWrite={canWrite} />
    </TocSection>
  );
}

// -------------------------------------------------------------- Deploy Policy (§46)

const DEPLOY_POLICIES = [
  {
    key: "override" as const,
    name: "Override in-progress deploys",
    description:
      "A new deploy cancels the one already running. Use this when the newest commit is always the one you want live.",
  },
  {
    key: "wait" as const,
    name: "Wait for in-progress deploys",
    description:
      "A new deploy queues until the running one finishes. Slower, but every commit is deployed in order.",
  },
];

function DeployPolicySection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { saving, save } = useSettingsSave(onChanged);
  const current = data.settings.deploy_policy;

  return (
    <TocSection
      id="deploy-policy"
      title="Overlapping Deploy Policy"
      description="What happens when a deploy starts while another one is still running."
    >
      <div className="space-y-2.5">
        {DEPLOY_POLICIES.map((policy) => (
          <label
            key={policy.key}
            className={cn(
              "flex items-start gap-2.5 rounded-md border p-3",
              policy.key === current ? "border-brand-strong bg-brand/20" : "border-border bg-card",
              canWrite ? "cursor-pointer" : "opacity-70",
            )}
          >
            <input
              type="radio"
              name="deploy-policy"
              value={policy.key}
              checked={policy.key === current}
              disabled={!canWrite || saving}
              onChange={() => void save({ deploy_policy: policy.key }, "Deploy policy updated")}
              className="mt-[3px] h-3.5 w-3.5 accent-[hsl(var(--brand))]"
            />
            <span className="min-w-0">
              <span className="block text-[13px] text-foreground">{policy.name}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {policy.description}
              </span>
            </span>
          </label>
        ))}
      </div>
      <ViewerNote canWrite={canWrite} />
    </TocSection>
  );
}

// ------------------------------------------------------ Registry Credentials (§47)

const REGISTRY_LABEL: Record<string, string> = {
  dockerhub: "Docker Hub",
  ghcr: "GitHub Container Registry",
  gitlab: "GitLab Registry",
  custom: "Custom registry",
};

function registryLabel(provider: string): string {
  return REGISTRY_LABEL[provider] ?? provider;
}

function RegistryCredentialsSection({ canWrite }: { canWrite: boolean }) {
  const scope = useScope();
  const [data, setData] = useState<RegistryCredentialsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const path = useMemo(() => scope("/api/integrations/registry-credentials"), [scope]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<RegistryCredentialsPayload>(path));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    try {
      await apiSend(`/api/integrations/registry-credentials/${id}`, "DELETE");
      toast.success("Credential deleted");
      setRemoving(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <TocSection
      id="registry-credentials"
      title="Registry Credentials"
      description="Used to pull private images when a service deploys. Saved passwords and tokens are encrypted and never shown again."
      action={
        canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add credential
          </Button>
        ) : null
      }
    >
      {error ? (
        <div className="rounded-md border border-danger-border bg-danger-surface p-3 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      {data === null ? (
        <div className="h-16 animate-pulse rounded-md border border-border bg-secondary/40" />
      ) : data.credentials.length === 0 ? (
        <Panel className="text-[12px] text-muted-foreground">
          No registry credentials. Public images deploy without one.
        </Panel>
      ) : (
        <div className="space-y-2.5">
          {data.credentials.map((cred) => (
            <Panel key={cred.id} className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-foreground">{cred.name}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {registryLabel(cred.provider)}
                  {cred.registry_host ? ` · ${cred.registry_host}` : ""} · {cred.username} · added{" "}
                  {dateLabel(cred.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-[3px] border border-border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
                  Secret stored
                </span>
                <Button
                  variant="bare"
                  size="icon"
                  aria-label={`Delete ${cred.name}`}
                  disabled={!canWrite}
                  onClick={() => setRemoving({ id: cred.id, name: cred.name })}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
      <ViewerNote canWrite={canWrite} />

      {data ? (
        <AddCredentialDialog
          open={adding}
          onOpenChange={setAdding}
          providers={data.providers}
          onDone={load}
        />
      ) : null}

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              Services that pull images with this credential will fail to deploy until another one
              is added. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removing && void remove(removing.id)}
            >
              Delete credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TocSection>
  );
}

function AddCredentialDialog({
  open,
  onOpenChange,
  providers,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: string[];
  onDone: () => Promise<void>;
}) {
  const scope = useScope();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState(providers[0] ?? "dockerhub");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setProvider(providers[0] ?? "dockerhub");
    setHost("");
    setUsername("");
    setSecret("");
  }, [open, providers]);

  // Mirrors the server's rule: only a custom registry needs an explicit host.
  const valid =
    name.trim().length > 0 &&
    username.trim().length > 0 &&
    secret.length > 0 &&
    (provider !== "custom" || host.trim().length > 0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await apiSend(scope("/api/integrations/registry-credentials"), "POST", {
        name: name.trim(),
        provider,
        registry_host: host.trim(),
        username: username.trim(),
        secret,
      });
      toast.success("Credential saved");
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add registry credential</DialogTitle>
            <DialogDescription>
              The password or token is encrypted on save and never returned by the API, so keep your
              own copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Field label="Name" htmlFor="reg-name">
              <Input
                id="reg-name"
                value={name}
                maxLength={60}
                placeholder="Production images"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Registry" htmlFor="reg-provider">
              <select
                id="reg-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
              >
                {providers.map((option) => (
                  <option key={option} value={option} className="bg-card">
                    {registryLabel(option)}
                  </option>
                ))}
              </select>
            </Field>
            {provider === "custom" ? (
              <Field label="Registry host" htmlFor="reg-host">
                <Input
                  id="reg-host"
                  value={host}
                  placeholder="registry.example.com"
                  onChange={(e) => setHost(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Username" htmlFor="reg-user">
              <Input id="reg-user" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password or access token" htmlFor="reg-secret">
              <Input
                id="reg-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save credential
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Security (§48)

function SecuritySection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { saving, save } = useSettingsSave(onChanged);
  const s = data.settings;
  const [require2fa, setRequire2fa] = useState(s.require_2fa);
  const [alerts, setAlerts] = useState(s.security_alerts);
  const [sessionTimeout, setSessionTimeout] = useState(
    s.session_timeout_minutes === null ? "" : String(s.session_timeout_minutes),
  );
  const [allowlist, setAllowlist] = useState(s.ip_allowlist ?? "");

  useEffect(() => {
    setRequire2fa(s.require_2fa);
    setAlerts(s.security_alerts);
    setSessionTimeout(s.session_timeout_minutes === null ? "" : String(s.session_timeout_minutes));
    setAllowlist(s.ip_allowlist ?? "");
  }, [s.require_2fa, s.security_alerts, s.session_timeout_minutes, s.ip_allowlist]);

  const unlocked = data.features.security;
  const parsedTimeout = sessionTimeout.trim() === "" ? null : Number(sessionTimeout);
  // Same window the server accepts: five minutes to thirty days.
  const timeoutInvalid =
    parsedTimeout !== null &&
    (!Number.isInteger(parsedTimeout) || parsedTimeout < 5 || parsedTimeout > 43200);

  const dirty =
    require2fa !== s.require_2fa ||
    alerts !== s.security_alerts ||
    parsedTimeout !== s.session_timeout_minutes ||
    allowlist.trim() !== (s.ip_allowlist ?? "");

  if (!unlocked) {
    return (
      <TocSection
        id="security"
        title="Security"
        description="Two-factor enforcement, session limits and IP restrictions for this workspace."
      >
        <PlanLockedCard
          feature="Security controls"
          required={data.feature_tiers.security}
          current={data.plan.key}
        />
      </TocSection>
    );
  }

  return (
    <TocSection
      id="security"
      title="Security"
      description="Applies to everyone in this workspace, including the owner."
    >
      <div className="space-y-2.5">
        <ToggleRow
          checked={require2fa}
          onChange={setRequire2fa}
          disabled={!canWrite}
          title="Require two-factor authentication"
          description="Members without 2FA are asked to enrol before they can open this workspace."
        />
        <ToggleRow
          checked={alerts}
          onChange={setAlerts}
          disabled={!canWrite}
          title="Send security alerts"
          description="Email the workspace owner on new sign-ins, role changes and failed logins."
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field
          label="Session timeout (minutes)"
          htmlFor="sec-timeout"
          hint="Leave blank to use the platform default. Between 5 and 43200 minutes."
        >
          <Input
            id="sec-timeout"
            inputMode="numeric"
            value={sessionTimeout}
            disabled={!canWrite}
            placeholder="Platform default"
            onChange={(e) => setSessionTimeout(e.target.value)}
          />
          {timeoutInvalid ? (
            <p className="mt-1.5 text-[11px] text-danger">
              Enter a whole number of minutes between 5 and 43200.
            </p>
          ) : null}
        </Field>
        <Field
          label="IP allow-list"
          htmlFor="sec-ips"
          hint="One address or CIDR block per line. Blank means no restriction."
        >
          <Textarea
            id="sec-ips"
            rows={4}
            value={allowlist}
            disabled={!canWrite}
            placeholder={"203.0.113.4\n198.51.100.0/24"}
            onChange={(e) => setAllowlist(e.target.value)}
          />
        </Field>
      </div>

      <Button
        size="sm"
        className="mt-4"
        disabled={!canWrite || !dirty || timeoutInvalid || saving}
        onClick={() =>
          void save(
            {
              require_2fa: require2fa,
              security_alerts: alerts,
              session_timeout_minutes: parsedTimeout,
              ip_allowlist: allowlist.trim() === "" ? null : allowlist,
            },
            "Security settings updated",
          )
        }
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Save security settings
      </Button>
      <ViewerNote canWrite={canWrite} />
    </TocSection>
  );
}

// ------------------------------------------------------------ Authentication (§49)

function AuthenticationSection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { saving, save } = useSettingsSave(onChanged);
  const s = data.settings;
  const [saml, setSaml] = useState(s.saml_enabled);
  const [metadata, setMetadata] = useState(s.saml_metadata_url ?? "");
  const [scim, setScim] = useState(s.scim_enabled);

  useEffect(() => {
    setSaml(s.saml_enabled);
    setMetadata(s.saml_metadata_url ?? "");
    setScim(s.scim_enabled);
  }, [s.saml_enabled, s.saml_metadata_url, s.scim_enabled]);

  const urlWrong = metadata.trim().length > 0 && !metadata.trim().startsWith("https://");
  // The server refuses to turn SSO on without an IdP, because that would lock
  // everyone out of sign-in. Mirror the rule so the button explains itself.
  const missingIdp = saml && metadata.trim().length === 0;
  const dirty =
    saml !== s.saml_enabled ||
    scim !== s.scim_enabled ||
    metadata.trim() !== (s.saml_metadata_url ?? "");

  if (!data.features.authentication) {
    return (
      <TocSection
        id="authentication"
        title="Authentication"
        description="SAML single sign-on and SCIM user provisioning for this workspace."
      >
        <PlanLockedCard
          feature="Single sign-on"
          required={data.feature_tiers.authentication}
          current={data.plan.key}
        />
      </TocSection>
    );
  }

  return (
    <TocSection
      id="authentication"
      title="Authentication"
      description="Members sign in through your identity provider instead of a password."
    >
      <div className="space-y-2.5">
        <ToggleRow
          checked={saml}
          onChange={setSaml}
          disabled={!canWrite}
          title="SAML single sign-on"
          description="Requires an IdP metadata URL. Without one, sign-in would break, so it cannot be enabled empty."
        />
        <ToggleRow
          checked={scim}
          onChange={setScim}
          disabled={!canWrite}
          title="SCIM provisioning"
          description="Your IdP creates and removes workspace members automatically."
        />
      </div>

      <div className="mt-4 max-w-[520px]">
        <Field
          label="IdP metadata URL"
          htmlFor="auth-metadata"
          hint="The HTTPS metadata endpoint from your identity provider."
        >
          <Input
            id="auth-metadata"
            value={metadata}
            disabled={!canWrite}
            placeholder="https://idp.example.com/app/metadata"
            onChange={(e) => setMetadata(e.target.value)}
          />
        </Field>
        {urlWrong ? (
          <p className="mt-1.5 text-[11px] text-danger">The metadata URL must start with https://.</p>
        ) : missingIdp ? (
          <p className="mt-1.5 text-[11px] text-danger">
            Add a metadata URL before turning single sign-on on.
          </p>
        ) : null}
      </div>

      <Button
        size="sm"
        className="mt-4"
        disabled={!canWrite || !dirty || urlWrong || missingIdp || saving}
        onClick={() =>
          void save(
            {
              saml_enabled: saml,
              scim_enabled: scim,
              saml_metadata_url: metadata.trim() === "" ? null : metadata.trim(),
            },
            "Authentication settings updated",
          )
        }
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Save authentication settings
      </Button>
      <ViewerNote canWrite={canWrite} />
    </TocSection>
  );
}

// ------------------------------------------------------------------- HIPAA (§50)

function HipaaSection({
  data,
  canWrite,
  onChanged,
}: {
  data: WorkspaceSettingsPayload;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { saving, save } = useSettingsSave(onChanged);
  const [confirming, setConfirming] = useState(false);
  const enabled = data.settings.hipaa_enabled;

  if (!data.features.hipaa) {
    return (
      <TocSection
        id="hipaa"
        title="HIPAA Compliance"
        description="Run workloads that handle protected health information."
      >
        <PlanLockedCard
          feature="HIPAA compliance"
          required={data.feature_tiers.hipaa}
          current={data.plan.key}
        />
      </TocSection>
    );
  }

  return (
    <TocSection
      id="hipaa"
      title="HIPAA Compliance"
      description="Turning this on records your acceptance of the Business Associate Agreement for this workspace."
    >
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-foreground">
                {enabled ? "HIPAA mode is on" : "HIPAA mode is off"}
              </span>
              {enabled ? (
                <span className="rounded-[3px] border border-success-border bg-success-surface px-1.5 py-[2px] text-[10px] font-medium uppercase tracking-[0.09em] text-success">
                  Enabled
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-[560px] text-[11px] leading-relaxed text-muted-foreground">
              {enabled && data.settings.hipaa_accepted_at
                ? `Accepted ${stampLabel(data.settings.hipaa_accepted_at)}. Every change to this setting is written to the audit log.`
                : "While on, this workspace enforces stricter logging and access rules, and the change is written to the audit log."}
            </p>
          </div>
          {enabled ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite || saving}
              onClick={() => void save({ hipaa_enabled: false }, "HIPAA mode turned off")}
            >
              Turn off
            </Button>
          ) : (
            <Button size="sm" disabled={!canWrite} onClick={() => setConfirming(true)}>
              Enable HIPAA
            </Button>
          )}
        </div>
        <ViewerNote canWrite={canWrite} />
      </Panel>

      <TypeToConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Enable HIPAA compliance"
        description="This records your acceptance of the Business Associate Agreement for this workspace and is written to the audit log."
        phrase="ENABLE HIPAA"
        confirmLabel="Enable HIPAA"
        onConfirm={async () => {
          const ok = await save({ hipaa_enabled: true }, "HIPAA mode enabled");
          if (ok) setConfirming(false);
        }}
      />
    </TocSection>
  );
}

/**
 * Shared strong confirmation (§77): the exact phrase has to be typed, so a
 * dangerous switch can never be flipped by a single stray click.
 */
function TypeToConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  phrase,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  phrase: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (typed !== phrase) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={1.75} />
              {title}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Field label={`Type “${phrase}” to continue`} htmlFor="confirm-phrase">
              <Input
                id="confirm-phrase"
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== phrase || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- Audit Logs (§51)

/** `workspace.member.invite` → `Workspace member invite`. */
function actionLabel(action: string): string {
  const words = action.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function AuditLogsSection() {
  const scope = useScope();
  const [data, setData] = useState<AuditLogsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false);

  // Filters are part of the query, so changing one refetches instead of
  // filtering a partial page in the browser.
  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), page_size: "25" });
    if (action) params.set("action", action);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [action, from, page, to]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<AuditLogsPayload>(scope(`/api/workspace/audit-logs?${query}`)));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [query, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async () => {
    setDownloading(true);
    try {
      await apiDownload(scope(`/api/workspace/audit-logs.csv?${query}`), "workspace-audit.csv");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const totalPages = data && data.page_size > 0 ? Math.ceil(data.total / data.page_size) : 1;

  if (data && !data.unlocked) {
    return (
      <TocSection
        id="audit-logs"
        title="Audit Logs"
        description="Every change made in this workspace, with who made it and from where."
      >
        <PlanLockedCard
          feature="Audit logs"
          required={data.required_plan}
          current={data.plan.key}
        />
      </TocSection>
    );
  }

  return (
    <TocSection
      id="audit-logs"
      title="Audit Logs"
      description="A permanent record of workspace activity. Entries cannot be edited or deleted."
      action={
        <Button size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          Export CSV
        </Button>
      }
    >
      {error ? (
        <div className="mb-3 rounded-md border border-danger-border bg-danger-surface p-3 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-full max-w-[220px]">
          <Field label="Action" htmlFor="audit-action">
            <select
              id="audit-action"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              className="h-9 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-ring"
            >
              <option value="" className="bg-card">
                All actions
              </option>
              {(data?.actions ?? []).map((option) => (
                <option key={option} value={option} className="bg-card">
                  {actionLabel(option)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="w-[160px]">
          <Field label="From" htmlFor="audit-from">
            <Input
              id="audit-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </Field>
        </div>
        <div className="w-[160px]">
          <Field label="To" htmlFor="audit-to">
            <Input
              id="audit-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </Field>
        </div>
        {action || from || to ? (
          <Button
            variant="bare"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setAction("");
              setFrom("");
              setTo("");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-secondary/30">
              {["Date", "User", "Action", "Resource", "IP", "Result"].map((head) => (
                <th
                  key={head}
                  className="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-[12px] text-muted-foreground">
                  Loading activity…
                </td>
              </tr>
            ) : data.logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-[12px] text-muted-foreground">
                  No activity recorded for this filter.
                </td>
              </tr>
            ) : (
              data.logs.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-muted-foreground">
                    {stampLabel(row.created_at)}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-foreground">
                    {/* A NULL actor is a platform action, not a person. */}
                    {row.user?.email ?? "System"}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-foreground">
                    {actionLabel(row.action)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {row.resource ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {row.ip ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "text-[12px]",
                        row.result === "success" ? "text-success" : "text-danger",
                      )}
                    >
                      {row.result === "success" ? "Success" : "Failure"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > data.page_size ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
            Page {data.page} of {totalPages} · {data.total.toLocaleString()} entries
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={data.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </TocSection>
  );
}

// ---------------------------------------------------------------- Documents (§52)

/**
 * Compliance documents. The platform has no signed reports to hand out yet, so
 * this says so plainly instead of offering a download that would 404 — the same
 * rule the rest of the page follows about not inventing data.
 */
function DocumentsSection({ data }: { data: WorkspaceSettingsPayload }) {
  return (
    <TocSection
      id="documents"
      title="Documents"
      description="Compliance reports and agreements covering this platform."
    >
      <div className="space-y-2.5">
        {data.documents.map((doc) => (
          <Panel key={doc.key} className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <FileText className="mt-[2px] h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <div className="min-w-0">
                <div className="text-[13px] text-foreground">{doc.name}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{doc.description}</div>
              </div>
            </div>
            <span className="text-[11px] text-muted-foreground">Available on request</span>
          </Panel>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        No signed copies are published for download yet. Ask support and we will send the current
        version for this workspace.
      </p>
    </TocSection>
  );
}

// --------------------------------------------------------- Delete Workspace (§53)

/**
 * The sentence under the danger panel. Each branch mirrors one of the server's
 * own refusals (`not_owner` / `not_empty` / `last_workspace`), so a disabled
 * button always comes with the real reason rather than a generic excuse.
 */
function deleteNote(data: WorkspaceSettingsPayload): string {
  switch (data.delete_block) {
    case "not_owner":
      return "Only the workspace owner can delete this workspace.";
    case "not_empty":
      return `This workspace still has ${data.resource_count} resource${
        data.resource_count === 1 ? "" : "s"
      }. Services are never destroyed as a side effect of deleting a workspace — move or delete them first.`;
    case "last_workspace":
      return "This is your only workspace, and every account needs one. Create another workspace before deleting this one.";
    default:
      return "The workspace, its projects, environments, team and billing profile are removed. This cannot be undone.";
  }
}

function DeleteWorkspaceSection({ data }: { data: WorkspaceSettingsPayload }) {
  const scope = useScope();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const remove = async (event: React.FormEvent) => {
    event.preventDefault();
    if (typed !== data.workspace.name) return;
    setBusy(true);
    try {
      await apiSend(scope("/api/workspace"), "DELETE", { name: typed });
      // The selected workspace is gone, so the switcher must fall back to the
      // account's own one rather than keep a dead id in localStorage.
      setActiveWorkspaceId(null);
      toast.success("Workspace deleted");
      setOpen(false);
      navigate("/", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TocSection
      id="delete-workspace"
      title="Delete Workspace"
      description="Deleting a workspace removes its projects, environments, team, billing profile and settings."
    >
      <div className="rounded-md border border-danger-border bg-danger-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-danger" strokeWidth={1.75} />
              <span className="text-[13px] font-medium text-foreground">
                Delete {data.workspace.name}
              </span>
            </div>
            <p className="mt-1 max-w-[560px] text-[11px] leading-relaxed text-muted-foreground">
              {deleteNote(data)}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={!data.can_delete}
            onClick={() => setOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Delete workspace
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={remove}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-danger" strokeWidth={1.75} />
                Delete this workspace
              </DialogTitle>
              <DialogDescription>
                This removes the workspace, its projects, environments, team members and billing
                profile. It cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              {/* §53: the exact workspace name, not a generic "DELETE". */}
              <Field label={`Type “${data.workspace.name}” to confirm`} htmlFor="delete-name">
                <Input
                  id="delete-name"
                  value={typed}
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={typed !== data.workspace.name || busy}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Delete workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TocSection>
  );
}
