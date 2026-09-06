// Admin User Detail (/admin/users/:id) — profile, counts, and tabbed sub-resources.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  User as UserIcon,
  Boxes,
  Rocket,
  Globe,
  Database,
  History,
  Loader2,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { UserBillingTab } from "@/components/admin/UserBillingTab";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet } from "@/lib/adminApi";
import type {
  AdminUserDetail as UserDetailData,
  AuditRow,
  DeploymentRow,
  EffectiveQuota,
  Project,
  UserCounts,
  UserDomainRow,
} from "@/lib/adminTypes";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/roles";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const QUOTA_LABELS: { key: keyof EffectiveQuota; label: string; countKey?: keyof UserCounts }[] = [
  { key: "max_apps", label: "Applications", countKey: "apps" },
  { key: "max_domains", label: "Domains", countKey: "domains" },
  { key: "max_backups", label: "Backups" },
  { key: "ram_mb", label: "RAM (MB)" },
  { key: "cpus_milli", label: "CPU (milli)" },
  { key: "storage_mb", label: "Storage (MB)" },
];

export default function AdminUserDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAdminMe();
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await adminGet<UserDetailData>(`/users/${id}`);
      setDetail(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
        <div className="h-64 animate-pulse rounded-2xl border border-border/60 bg-secondary/20" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-16 text-center">
        <p className="text-sm text-danger">{error || "User not found"}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/admin/users">
            <ArrowLeft className="h-4 w-4" /> Back to users
          </Link>
        </Button>
      </div>
    );
  }

  const { user, counts, effective } = detail;

  return (
    <>
      <PageHeader
        title={user.name}
        description={user.email}
        icon={UserIcon}
        eyebrow={roleLabel(user.role)}
        actions={
          <Button asChild variant="outline" className="h-10 border-border/60">
            <Link to="/admin/users">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
          </Button>
        }
        meta={
          <>
            <StatusBadge status={user.status} size="sm" />
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-secondary/40 px-3 py-1.5 text-sm">
              {user.plan_name || user.plan_key || "No plan"}
            </span>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountTile label="Applications" value={counts.apps} icon={Boxes} />
        <CountTile label="Domains" value={counts.domains} icon={Globe} />
        <CountTile label="Deployments" value={counts.deployments} icon={Rocket} />
        <CountTile label="Databases" value={counts.databases} icon={Database} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex w-full flex-wrap justify-start gap-1 overflow-x-auto">
          <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
          <TabsTrigger value="apps" className="px-4">Applications</TabsTrigger>
          <TabsTrigger value="deployments" className="px-4">Deployments</TabsTrigger>
          <TabsTrigger value="domains" className="px-4">Domains</TabsTrigger>
          <TabsTrigger value="databases" className="px-4">Databases</TabsTrigger>
          {/* Cosmetic gate only — `/users/:id/billing` refuses without the
              permission anyway; this stops the tab being a guaranteed 403. */}
          {can("billing.view") && (
            <TabsTrigger value="billing" className="px-4">Billing</TabsTrigger>
          )}
          <TabsTrigger value="usage" className="px-4">Usage</TabsTrigger>
          <TabsTrigger value="activity" className="px-4">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <InfoCard title="Account">
              <InfoRow label="Name" value={user.name} />
              <InfoRow label="Email" value={user.email} />
              <InfoRow label="Role" value={roleLabel(user.role)} />
              <InfoRow label="Status" value={user.status} />
              <InfoRow label="Created" value={formatDateTime(user.created_at)} />
            </InfoCard>
            <InfoCard title="Plan">
              <InfoRow label="Plan" value={user.plan_name || "—"} />
              <InfoRow label="Key" value={user.plan_key || "—"} />
              <InfoRow label="Apps used" value={String(user.app_count)} />
            </InfoCard>
          </div>
        </TabsContent>

        <TabsContent value="apps">
          <AppsTab userId={user.id} />
        </TabsContent>
        <TabsContent value="deployments">
          <DeploymentsTab userId={user.id} />
        </TabsContent>
        <TabsContent value="domains">
          <DomainsTab userId={user.id} />
        </TabsContent>
        <TabsContent value="databases">
          <DatabasesTab userId={user.id} />
        </TabsContent>
        {can("billing.view") && (
          <TabsContent value="billing">
            <UserBillingTab userId={user.id} />
          </TabsContent>
        )}
        <TabsContent value="usage">
          <UsageTab effective={effective} counts={counts} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab userId={user.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function CountTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Boxes;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="space-y-0">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium capitalize">{value}</span>
    </div>
  );
}

// ---- Lazy sub-resource tabs (fetch on first render) ----

function useSubResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    adminGet<T>(path)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, loading, error };
}

function TabState({
  loading,
  error,
  empty,
  emptyLabel,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-8 text-center text-sm text-danger">
        {error}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return <>{children}</>;
}

function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">{children}</table>
      </div>
    </div>
  );
}

const TH = "px-4 py-3 font-semibold";
const THEAD =
  "border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

function AppsTab({ userId }: { userId: string }) {
  const { data, loading, error } = useSubResource<Project[]>(`/users/${userId}/apps`);
  const rows = data ?? [];
  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyLabel="No applications.">
      <TableWrap>
        <thead>
          <tr className={THEAD}>
            <th className={TH}>Name</th>
            <th className={TH}>Type</th>
            <th className={TH}>Status</th>
            <th className={TH}>Domain</th>
            <th className={TH}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-border/40 last:border-b-0">
              <td className="px-4 py-3 font-medium">
                <Link to={`/projects/${p.id}`} className="hover:text-brand hover:underline">
                  {p.name}
                </Link>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{p.project_type}</td>
              <td className="px-4 py-3">
                <StatusBadge status={p.status} size="sm" />
              </td>
              <td className="px-4 py-3 text-muted-foreground">{p.domain || "—"}</td>
              <td className="px-4 py-3 tabular-nums text-muted-foreground">
                {formatDateTime(p.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </TabState>
  );
}

function DeploymentsTab({ userId }: { userId: string }) {
  const { data, loading, error } = useSubResource<DeploymentRow[]>(`/users/${userId}/deployments`);
  const rows = data ?? [];
  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyLabel="No deployments.">
      <TableWrap>
        <thead>
          <tr className={THEAD}>
            <th className={TH}>App</th>
            <th className={TH}>Status</th>
            <th className={TH}>Trigger</th>
            <th className={TH}>Commit</th>
            <th className={TH}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-b border-border/40 last:border-b-0">
              <td className="px-4 py-3 font-medium">
                <Link to={`/projects/${d.project.id}`} className="hover:text-brand hover:underline">
                  {d.project.name}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={d.status} size="sm" />
              </td>
              <td className="px-4 py-3 text-muted-foreground">{d.trigger || "—"}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {d.commit_sha ? d.commit_sha.slice(0, 7) : "—"}
              </td>
              <td className="px-4 py-3 tabular-nums text-muted-foreground">
                {formatDateTime(d.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </TabState>
  );
}

function DomainsTab({ userId }: { userId: string }) {
  const { data, loading, error } = useSubResource<UserDomainRow[]>(`/users/${userId}/domains`);
  const rows = data ?? [];
  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyLabel="No domains.">
      <TableWrap>
        <thead>
          <tr className={THEAD}>
            <th className={TH}>Domain</th>
            <th className={TH}>App</th>
            <th className={TH}>Service</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={`${d.domain}-${i}`} className="border-b border-border/40 last:border-b-0">
              <td className="px-4 py-3 font-medium">
                <a
                  href={`https://${d.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-brand hover:underline"
                >
                  {d.domain}
                </a>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{d.app}</td>
              <td className="px-4 py-3 text-muted-foreground">{d.service}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </TabState>
  );
}

function DatabasesTab({ userId }: { userId: string }) {
  const { data, loading, error } = useSubResource<Project[]>(`/users/${userId}/databases`);
  const rows = data ?? [];
  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyLabel="No databases.">
      <TableWrap>
        <thead>
          <tr className={THEAD}>
            <th className={TH}>Name</th>
            <th className={TH}>Engine</th>
            <th className={TH}>Status</th>
            <th className={TH}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-border/40 last:border-b-0">
              <td className="px-4 py-3 font-medium">
                <Link to={`/projects/${p.id}`} className="hover:text-brand hover:underline">
                  {p.name}
                </Link>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{p.db_engine || "—"}</td>
              <td className="px-4 py-3">
                <StatusBadge status={p.status} size="sm" />
              </td>
              <td className="px-4 py-3 tabular-nums text-muted-foreground">
                {formatDateTime(p.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </TabState>
  );
}

function UsageTab({ effective, counts }: { effective: EffectiveQuota; counts: UserCounts }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {QUOTA_LABELS.map(({ key, label, countKey }) => {
        const limit = effective[key];
        const used = countKey ? counts[countKey] : null;
        const unlimited = limit === null;
        const pct =
          used !== null && !unlimited && limit && limit > 0
            ? Math.min(100, (used / limit) * 100)
            : 0;
        return (
          <div key={key} className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">{label}</span>
              <span className="tabular-nums text-muted-foreground">
                {used !== null ? `${used} / ` : ""}
                {unlimited ? "Unlimited" : limit}
              </span>
            </div>
            {used !== null && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success",
                  )}
                  style={{ width: unlimited ? "0%" : `${pct}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActivityTab({ userId }: { userId: string }) {
  const { data, loading, error } = useSubResource<AuditRow[]>(`/users/${userId}/activity`);
  const rows = data ?? [];
  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyLabel="No activity.">
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card px-4 py-3"
          >
            <div className="flex min-w-0 items-start gap-3">
              <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium">{row.action}</p>
                {row.resource && (
                  <p className="truncate text-xs text-muted-foreground">{row.resource}</p>
                )}
              </div>
            </div>
            <div className="shrink-0 text-right text-xs text-muted-foreground">
              <p className="tabular-nums">{formatDateTime(row.created_at)}</p>
              {row.ip && <p className="font-mono">{row.ip}</p>}
            </div>
          </div>
        ))}
      </div>
    </TabState>
  );
}
