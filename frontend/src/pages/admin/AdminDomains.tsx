// Admin Domains (/admin/domains) — the platform's own domain, plus every
// hostname the platform currently serves for a tenant.
//
// Two things live on this page. The base domain (e.g. `godhosting.bond`) is the
// apex the operator owns; with auto-subdomain on, any service deployed without a
// hostname of its own is published at `<app>.<base>` at the start of its next
// deploy. Below that is the inventory — one row per hostname actually stored on a
// service, with certificate state read from certbot. Nothing here is invented: a
// domain only appears once a real service row holds it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { AdminDomainsResponse, AdminSettings } from "@/lib/adminTypes";
import { cn, copyToClipboard } from "@/lib/utils";

const PAGE_SIZE = 20;
/** The one shape a single `*.base` wildcard DNS record can cover. */
const DEFAULT_TEMPLATE = "{slug}.{base}";

/** Mirrors the server's normalizeBaseDomain so the preview matches what saves. */
function normalizeBase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
}

function renderPreview(template: string, base: string, slug = "my-app"): string {
  if (!base) return "";
  return (template || DEFAULT_TEMPLATE)
    .replace(/\{slug\}/g, slug)
    .replace(/\{base\}/g, base);
}

/** A template is wildcard-coverable only when the slug sits in its own label. */
function isWildcardCoverable(template: string): boolean {
  return (template || DEFAULT_TEMPLATE).trim() === DEFAULT_TEMPLATE;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function AdminDomains() {
  const [data, setData] = useState<AdminDomainsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  // Draft settings — kept separate from `data.config` so typing never fights the
  // list refresh, and Save sends exactly what is on screen.
  const [baseDomain, setBaseDomain] = useState("");
  const [autoSubdomain, setAutoSubdomain] = useState(true);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ]);

  const fetchDomains = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search: debouncedQ,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const res = await adminGet<AdminDomainsResponse>(`/domains?${params.toString()}`);
      setData(res);
      setError(null);
      // Only adopt server values while the operator has no unsaved edits.
      setDirty((isDirty) => {
        if (!isDirty) {
          setBaseDomain(res.config.base_domain ?? "");
          setAutoSubdomain(res.config.auto_subdomain_enabled);
          setTemplate(res.config.subdomain_template || DEFAULT_TEMPLATE);
        }
        return isDirty;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load domains");
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, page]);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  const normalizedBase = useMemo(() => normalizeBase(baseDomain), [baseDomain]);
  const preview = useMemo(
    () => renderPreview(template, normalizedBase),
    [template, normalizedBase],
  );
  const templateValid = template.includes("{slug}") && template.includes("{base}");
  const baseValid = normalizedBase === "" || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalizedBase);

  const save = async () => {
    if (!templateValid) {
      toast.error("Template must contain {slug} and {base}");
      return;
    }
    if (!baseValid) {
      toast.error("Base domain must be a hostname like godhosting.bond");
      return;
    }
    setSaving(true);
    try {
      await adminSend<AdminSettings>("/settings", "PATCH", {
        base_domain: normalizedBase,
        auto_subdomain_enabled: autoSubdomain,
        subdomain_template: template.trim() || DEFAULT_TEMPLATE,
      });
      toast.success(
        normalizedBase
          ? `Base domain set to ${normalizedBase}`
          : "Base domain cleared — new apps get no automatic hostname",
      );
      setDirty(false);
      fetchDomains();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save domain settings");
    } finally {
      setSaving(false);
    }
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const serverIp = data?.server_ip ?? null;

  return (
    <>
      <PageHeader
        title="Domains & DNS"
        description="Your platform domain, the subdomain every app gets under it, and every hostname served today."
        icon={Globe}
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={fetchDomains}
            title="Refresh"
            className="h-10 w-10 border-border/60 bg-background hover:bg-secondary/80"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      />

      {/* ── Platform domain ─────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Platform domain</h2>
            <p className="text-xs text-muted-foreground">
              The apex you own. Every app deployed without its own hostname is published
              beneath it.
            </p>
          </div>
          {/* Invalid input can't be saved, so the button says so rather than letting
              the click through to a toast the operator has to read. */}
          <Button
            onClick={save}
            disabled={saving || !dirty || !templateValid || !baseValid}
            className="h-10 shrink-0"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Base domain</span>
            <Input
              value={baseDomain}
              onChange={(e) => {
                setBaseDomain(e.target.value);
                setDirty(true);
              }}
              placeholder="godhosting.bond"
              spellCheck={false}
              autoCapitalize="none"
              className={cn("font-mono", !baseValid && "border-danger")}
            />
            <span className="block text-[11px] text-muted-foreground">
              {baseValid
                ? "Leave empty to turn automatic hostnames off."
                : "Must be a hostname like godhosting.bond."}
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Hostname template</span>
            <Input
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                setDirty(true);
              }}
              placeholder={DEFAULT_TEMPLATE}
              spellCheck={false}
              autoCapitalize="none"
              className={cn("font-mono", !templateValid && "border-danger")}
            />
            <span className="block text-[11px] text-muted-foreground">
              {templateValid
                ? "{slug} is the app name, {base} the domain above."
                : "Must contain both {slug} and {base}."}
            </span>
          </label>
        </div>

        <div className="mt-4 flex flex-col gap-4 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Give every new app a hostname</p>
              <p className="text-xs text-muted-foreground">
                Applied at the start of each deploy. A service that already has a custom
                domain is never touched.
              </p>
            </div>
          </div>
          <Switch
            label="Automatic subdomains"
            checked={autoSubdomain}
            onChange={(v) => {
              setAutoSubdomain(v);
              setDirty(true);
            }}
          />
        </div>

        {/* What the operator will actually get — rendered from the live draft. */}
        {normalizedBase && templateValid && (
          <div className="mt-4 rounded-xl border border-border/60 bg-secondary/20 px-4 py-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
              An app named “my-app” will be published at
            </p>
            <p className="mt-1 break-all font-mono text-sm font-medium text-foreground">
              https://{preview}
            </p>
            {!isWildcardCoverable(template) && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  This template does not put the app in its own DNS label, so a{" "}
                  <span className="font-mono">*.{normalizedBase}</span> wildcard record cannot
                  cover it — each app needs its own DNS record. Use{" "}
                  <span className="font-mono">{DEFAULT_TEMPLATE}</span> to cover them all with
                  one record.
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── DNS records to create ───────────────────────────────────────────── */}
      {normalizedBase && (
        <div className="mb-4 rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
          <h2 className="text-base font-semibold">DNS records</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Add these at your registrar. Until they resolve, hostnames under{" "}
            <span className="font-mono">{normalizedBase}</span> will not reach this server and
            certificates cannot be issued.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <th className="pb-2 pr-4 font-semibold">Type</th>
                  <th className="pb-2 pr-4 font-semibold">Name</th>
                  <th className="pb-2 font-semibold">Value</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                <tr className="border-b border-border/40">
                  <td className="py-2.5 pr-4">A</td>
                  <td className="py-2.5 pr-4">*.{normalizedBase}</td>
                  <td className="py-2.5">
                    <CopyValue value={serverIp} />
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4">A</td>
                  <td className="py-2.5 pr-4">{normalizedBase}</td>
                  <td className="py-2.5">
                    <CopyValue value={serverIp} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {!serverIp && (
            <p className="mt-3 flex items-start gap-1.5 text-[11px] text-warning">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              This server&apos;s public IP could not be detected — point the records at the
              address you reach this panel on.
            </p>
          )}
        </div>
      )}

      {/* ── Inventory ───────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search hostname, app or owner email…"
            className="pl-9"
          />
        </div>
        {data && (
          <div className="flex shrink-0 gap-1.5 text-xs">
            <span className="rounded-xl border border-brand/30 bg-brand/10 px-3 py-1.5 font-medium text-brand">
              {data.counts.managed} on {normalizedBase || "base domain"}
            </span>
            <span className="rounded-xl border border-border/60 bg-secondary/40 px-3 py-1.5 font-medium text-muted-foreground">
              {data.counts.custom} custom
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="overflow-hidden rounded-2xl border border-border/60">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse border-b border-border/40 bg-secondary/20 last:border-b-0"
            />
          ))}
        </div>
      ) : !data || data.domains.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 px-4 py-16 text-center text-sm text-muted-foreground">
          {debouncedQ
            ? "No hostname matches that search."
            : "No hostnames yet — they appear here once an app is deployed or a custom domain is added."}
        </div>
      ) : (
        <DomainTable rows={data.domains} />
      )}

      {total > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{total}</span> hostname
            {total === 1 ? "" : "s"} served
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-muted-foreground">
              {page} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-border/60"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** Hostname inventory — cards on small screens, a table from `md` up. */
function DomainTable({ rows }: { rows: AdminDomainsResponse["domains"] }) {
  return (
    <>
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <article
            key={`${row.service_id}:${row.hostname}`}
            className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <a
                href={`https://${row.hostname}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 break-all font-mono text-sm font-medium underline decoration-border underline-offset-4 hover:text-brand"
              >
                {row.hostname}
              </a>
              <SslBadge ssl={row.ssl} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{row.project_name ?? "—"}</span>
              <span>·</span>
              <span>{row.service_name}</span>
              {row.owner && (
                <>
                  <span>·</span>
                  <span className="truncate">{row.owner.email}</span>
                </>
              )}
            </div>
            <div className="mt-2">
              <ScopeBadge managed={row.managed} />
            </div>
          </article>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-2xl border border-border/60 bg-card md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-secondary/30 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Hostname</th>
                <th className="px-4 py-3 font-semibold">Application</th>
                <th className="px-4 py-3 font-semibold">Owner</th>
                <th className="px-4 py-3 font-semibold">Scope</th>
                <th className="px-4 py-3 font-semibold">SSL</th>
                <th className="px-4 py-3 font-semibold">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.service_id}:${row.hostname}`}
                  className="border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40"
                >
                  <td className="px-4 py-3">
                    <a
                      href={`https://${row.hostname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-mono text-xs font-medium underline decoration-border underline-offset-4 hover:text-brand"
                    >
                      {row.hostname}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    {row.project_id ? (
                      <Link
                        to={`/projects/${row.project_id}`}
                        className="font-medium hover:text-brand"
                      >
                        {row.project_name ?? "Project"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      / {row.service_name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.owner ? (
                      <Link
                        to={`/admin/users/${row.owner.id}`}
                        className="hover:text-brand"
                        title={row.owner.email}
                      >
                        {row.owner.email}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ScopeBadge managed={row.managed} />
                  </td>
                  <td className="px-4 py-3">
                    <SslBadge ssl={row.ssl} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {formatDate(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Platform-issued vs the tenant's own domain — different support burden. */
function ScopeBadge({ managed }: { managed: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-lg border px-2 py-0.5 text-[11px] font-medium",
        managed
          ? "border-brand/30 bg-brand/10 text-brand"
          : "border-border/60 bg-secondary/40 text-muted-foreground",
      )}
    >
      {managed ? "Platform" : "Custom"}
    </span>
  );
}

/**
 * Certificate state straight from certbot. `null` means the check itself failed,
 * which is not the same as "no certificate" — say so rather than guess.
 */
function SslBadge({ ssl }: { ssl: AdminDomainsResponse["domains"][number]["ssl"] }) {
  if (!ssl) {
    return <span className="text-[11px] text-muted-foreground">Unknown</span>;
  }
  const tone =
    ssl.status === "active"
      ? "border-success-border bg-success-surface text-success"
      : ssl.status === "expiring" || ssl.status === "pending"
        ? "border-warning-border bg-warning-surface text-warning"
        : ssl.status === "missing"
          ? "border-border/60 bg-secondary/40 text-muted-foreground"
          : "border-danger-border bg-danger-surface text-danger";
  const Icon = ssl.status === "active" ? ShieldCheck : ShieldAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium capitalize",
        tone,
      )}
      title={ssl.expires_at ? `Expires ${formatDate(ssl.expires_at)}` : undefined}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {ssl.status}
    </span>
  );
}

/** A DNS value with a copy button — these get pasted into a registrar form. */
function CopyValue({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) {
    return <span className="text-muted-foreground">your server IP</span>;
  }
  const copy = async () => {
    if (!(await copyToClipboard(value))) {
      toast.error("Could not copy");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2 py-1 transition-colors hover:bg-secondary"
      title="Copy"
    >
      {value}
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        checked ? "bg-brand" : "bg-secondary",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-sm transition-transform",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
