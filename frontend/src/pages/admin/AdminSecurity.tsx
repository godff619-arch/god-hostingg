// Admin → Security (/admin/security) — §29, §30, §31 in four tabs.
//
// Every number on this page is a `count` over a real table. A fresh install shows
// zeros and empty states, which is the honest answer to "has anyone tried to break
// in yet" (§53) — there is no seeded demo row and no 99.9% anywhere.
//
// The tabs are the three questions an operator actually arrives with:
//
//   Overview   — is anything happening right now that I should look at?
//   Sign-ins   — who has been trying to get in, and did they succeed?
//   Sessions   — whose browsers are holding a live token, and can I end one?
//   API keys   — what machine credentials exist, and is any of them unused?
//
// Permissions are read from `/me` and only decide what is worth offering. Every
// route behind this page runs `adminPermissionGate` first: `/security` and
// `/sessions` need `security.view`/`security.manage`, `/api-keys` needs
// `security.view`/`apikeys.manage`. Hiding a button here is cosmetic.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { PageHeader, StatChip } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ListEmpty,
  ListError,
  Metric,
  MetricStrip,
  ToneBadge,
} from "@/components/admin/AdminList";
import { SecurityAttemptsTable } from "@/components/admin/SecurityAttemptsTable";
import { SecuritySessionsTable } from "@/components/admin/SecuritySessionsTable";
import { SecurityApiKeys } from "@/components/admin/SecurityApiKeys";
import { useAdminMe } from "@/hooks/useAdminMe";
import { adminGet } from "@/lib/adminApi";
import type { SecurityOverview } from "@/lib/adminSecurityTypes";
import { outcomeLabel, outcomeTone } from "@/lib/adminSecurityTypes";
import { formatDateTime, relativeDays } from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** A card with a heading, used by the three overview panels. */
function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function AdminSecurity() {
  const { me, can } = useAdminMe();
  const canManage = can("security.manage");
  const canKeys = can("apikeys.manage");
  // Ending another operator's session is a super-admin action; the server checks
  // `isSuperAdmin` and answers 403. Mirrored here only to explain the disabled button.
  const canRevokeOthers = me?.role === "owner" || me?.role === "super_admin";

  const [data, setData] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminGet<SecurityOverview>("/security/overview"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the security overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Security"
        eyebrow="System"
        description="Who has tried to sign in, whose browsers hold a live token right now, and which machine keys can reach the API. Counted from the tables, not estimated."
        icon={ShieldCheck}
        meta={
          t ? (
            <>
              <StatChip label="Admin accounts" value={t.admin_accounts} tone="neutral" />
              <StatChip
                label="Live sessions"
                value={t.live_sessions}
                tone={t.suspicious_sessions > 0 ? "warning" : "success"}
              />
              {t.locked_accounts > 0 && (
                <StatChip label="Locked out" value={t.locked_accounts} tone="warning" />
              )}
            </>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={load}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        }
      />

      {error && <ListError message={error} onRetry={load} />}

      <MetricStrip>
        <Metric
          label="Failed sign-ins (24h)"
          value={t?.failed_24h ?? 0}
          tone={(t?.failed_24h ?? 0) > 0 ? "warning" : "success"}
          hint={`${t?.failed_7d ?? 0} in the last 7 days`}
          loading={loading}
        />
        <Metric
          label="Successful (24h)"
          value={t?.success_24h ?? 0}
          hint="Every account, not just operators"
          loading={loading}
        />
        <Metric
          label="Locked accounts"
          value={t?.locked_accounts ?? 0}
          tone={(t?.locked_accounts ?? 0) > 0 ? "warning" : "neutral"}
          hint="Too many wrong passwords; clears itself"
          loading={loading}
        />
        <Metric
          label="Active API keys"
          value={t?.active_keys ?? 0}
          tone={(t?.expiring_keys ?? 0) > 0 ? "warning" : "neutral"}
          hint={
            (t?.expiring_keys ?? 0) > 0
              ? `${t?.expiring_keys} expiring within 7 days`
              : "None expiring this week"
          }
          loading={loading}
        />
      </MetricStrip>

      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">
            <Activity className="h-4 w-4" /> Overview
          </TabsTrigger>
          <TabsTrigger value="attempts">
            <UserCheck className="h-4 w-4" /> Sign-ins
            {(t?.failed_24h ?? 0) > 0 && (
              <span className="rounded-full bg-warning-surface px-1.5 py-0.5 text-[10px] font-bold text-warning ring-1 ring-warning-border">
                {t?.failed_24h}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="sessions">
            <MonitorSmartphone className="h-4 w-4" /> Sessions
            {(t?.suspicious_sessions ?? 0) > 0 && (
              <span className="rounded-full bg-warning-surface px-1.5 py-0.5 text-[10px] font-bold text-warning ring-1 ring-warning-border">
                {t?.suspicious_sessions}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="keys">
            <KeyRound className="h-4 w-4" /> API keys
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-3 stagger-in">
            <div className="lg:col-span-2">
              <Panel
                title="Latest sign-in attempts"
                hint="The last eight, whatever the outcome. The full log is in the Sign-ins tab."
              >
                {loading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="h-10 animate-pulse rounded-xl bg-secondary/30" />
                    ))}
                  </div>
                ) : (data?.recent_attempts.length ?? 0) === 0 ? (
                  <ListEmpty
                    message="Nobody has tried to sign in yet."
                    hint="Every attempt from now on is recorded, successful ones included."
                  />
                ) : (
                  <ul className="divide-y divide-border/40">
                    {data?.recent_attempts.map((a) => (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{a.email}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            <span className="font-mono">{a.ip || "no address"}</span> ·{" "}
                            {formatDateTime(a.created_at)}
                          </span>
                        </span>
                        <ToneBadge label={outcomeLabel(a.outcome)} tone={outcomeTone(a.outcome)} />
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <Panel
              title="Addresses failing most"
              hint="Failed attempts per IP over the last 7 days."
            >
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-8 animate-pulse rounded-xl bg-secondary/30" />
                  ))}
                </div>
              ) : (data?.offenders.length ?? 0) === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No failed sign-in has an address attached yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data?.offenders.map((o) => (
                    <li
                      key={o.ip ?? "unknown"}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2"
                    >
                      <span className="truncate font-mono text-xs">{o.ip ?? "unknown"}</span>
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-danger">
                        {o.attempts} failed
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                An address behind a shared office NAT will appear here after a few honest typos.
                Read it alongside the outcome, not on its own.
              </p>
            </Panel>
          </div>

          <div className="mt-4">
            <Panel
              title="Operator sessions in use"
              hint="The five most recently active. Customer sign-ins do not get a session row."
            >
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-xl bg-secondary/30" />
                  ))}
                </div>
              ) : (data?.recent_sessions.length ?? 0) === 0 ? (
                <ListEmpty
                  message="No operator session is live."
                  hint="A row appears here the moment somebody with admin access signs in."
                />
              ) : (
                <ul className="divide-y divide-border/40">
                  {data?.recent_sessions.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {s.email ?? s.user_id}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {s.device || "Unknown device"} ·{" "}
                          <span className="font-mono">{s.ip || "no address"}</span> · last seen{" "}
                          {relativeDays(s.last_seen_at)}
                        </span>
                      </span>
                      {s.suspicious && <ToneBadge label="New device or IP" tone="warning" />}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="attempts">
          <SecurityAttemptsTable />
        </TabsContent>

        <TabsContent value="sessions">
          <SecuritySessionsTable
            canManage={canManage}
            canRevokeOthers={Boolean(canRevokeOthers)}
            onChanged={load}
          />
        </TabsContent>

        <TabsContent value="keys">
          <SecurityApiKeys canManage={canKeys} onChanged={load} />
        </TabsContent>
      </Tabs>
    </>
  );
}

