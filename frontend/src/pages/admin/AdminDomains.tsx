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
import { refreshEdgeInfo, useEdgeInfo, type EdgeDns } from "@/hooks/useEdgeInfo";
import { adminGet, adminSend } from "@/lib/adminApi";
import type { AdminDomainsResponse, AdminEdgeInfo, AdminSettings } from "@/lib/adminTypes";
import { cn, copyToClipboard } from "@/lib/utils";

const PAGE_SIZE = 20;
/** The one shape a single `*.base` wildcard DNS record can cover. */
const DEFAULT_TEMPLATE = "{slug}.{base}";

/**
 * How hostnames physically reach containers on this host. An operator setting a
 * base domain needs to know this before they trust the preview above: on a VPS
 * where another proxy already owns 80/443, God Hosting publishes apps *through*
 * that proxy, and it cannot serve the panel's own hostname at all.
 */
function EdgeBanner({ edge }: { edge: AdminEdgeInfo }) {
  const tone =
    edge.mode === "none"
      ? {
          box: "border-warning-border bg-warning-surface",
          icon: "text-warning",
          Icon: TriangleAlert,
          title: "No edge proxy on this host",
        }
      : edge.mode === "traefik"
        ? {
            box: "border-border/60 bg-secondary/20",
            icon: "text-brand",
            Icon: Globe,
            title: `Apps are published through ${edge.container}`,
          }
        : {
            box: "border-success-border bg-success-surface",
            icon: "text-success",
            Icon: ShieldCheck,
            title: `Served by ${edge.container}`,
          };
  return (
    <div className={cn("mb-4 rounded-2xl border p-4 sm:p-5", tone.box)}>
      <div className="flex items-start gap-3">
        <tone.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">{tone.title}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{edge.reason}</p>
          {edge.mode === "traefik" && !edge.cert_resolver && (
            <p className="text-[11px] leading-relaxed text-warning">
              That proxy has no ACME resolver configured, so hostnames serve plain HTTP until
              one is. Add a certificate resolver to it for HTTPS.
            </p>
          )}
          {edge.mode === "traefik" && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Routing labels are written when an app deploys — redeploy a service after
              changing its domain.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

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

/**
 * Live verdict for one DNS record.
 *
 * The table used to only say what to create, so an operator who mistyped the
 * record — or never added it — saw the same green page as one whose DNS was
 * perfect, and found out from a user hitting NXDOMAIN. This is resolved against a
 * public resolver on the server, so it is what the internet sees, not what this
 * browser's cache holds.
 */
function DnsStatus({ dns }: { dns: EdgeDns | null }) {
  if (!dns) {
    return <span className="text-[11px] font-sans text-muted-foreground">Checking…</span>;
  }
  const view = {
    ok: {
      label: "Resolving here",
      className: "border-success-border bg-success-surface text-success",
      Icon: ShieldCheck,
    },
    elsewhere: {
      label: "Points elsewhere",
      className: "border-warning-border bg-warning-surface text-warning",
      Icon: TriangleAlert,
    },
    missing: {
      label: "Not found",
      className: "border-danger-border bg-danger-surface text-danger",
      Icon: ShieldAlert,
    },
    unknown: {
      label: "Not verified",
      className: "border-border/60 bg-secondary/40 text-muted-foreground",
      Icon: Globe,
    },
  }[dns.verdict];
  const { Icon } = view;

  return (
    <span
      title={
        dns.addresses.length
          ? `Resolves to ${dns.addresses.join(", ")}`
          : "No A or AAAA record found"
      }
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-0.5 font-sans text-[11px] font-medium",
        view.className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {view.label}
    </span>
  );
}

export default function AdminDomains() {
  const [data, setData] = useState<AdminDomainsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // Whether the records below actually resolve. Probed on the server against a
  // public resolver; `refreshEdgeInfo` re-probes after the operator adds them.
  const edge = useEdgeInfo();
  const [rechecking, setRechecking] = useState(false);

  // Draft settings — kept separate from `data.config` so typing never fights the
  // list refresh, and Save sends exactly what is on screen.
  const [baseDomain, setBaseDomain] = useState("");
  const [autoSubdomain, setAutoSubdomain] = useState(true);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

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
      // The DNS card below is keyed on the *saved* base domain, so without this it
      // would appear stuck on "Checking…" against the old cached probe.
      void refreshEdgeInfo();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save domain settings");
    } finally {
      setSaving(false);
    }
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const serverIp = data?.server_ip ?? null;
  const savedBase = data?.config.base_domain ?? "";
  /** Only claim HTTPS where something on this host actually terminates it. */
  const previewScheme =
    data?.edge && !(data.edge.mode === "nginx" || data.edge.cert_resolver) ? "http" : "https";

  // Setting the base domain only governs *future* deploys, so apps already
  // running on `ip:port` would stay there and the setting would look inert.
  const backfill = async () => {
    setBackfilling(true);
    try {
      const res = await adminSend<{
        assigned: { project: string; service: string; domain: string }[];
        skipped: number;
        note: string;
      }>("/domains/backfill", "POST", {});
      if (res.assigned.length === 0) {
        toast.info(res.note);
      } else {
        toast.success(
          res.assigned.length === 1
            ? `${res.assigned[0].service} → ${res.assigned[0].domain}`
            : `${res.assigned.length} services got a hostname`,
          { description: res.note },
        );
      }
      fetchDomains();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign subdomains");
    } finally {
      setBackfilling(false);
    }
  };

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

      {data?.edge && <EdgeBanner edge={data.edge} />}

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

        {/* Existing apps predate the setting. Without this they keep answering on
            `ip:port` until someone redeploys each one by hand. */}
        {savedBase && (
          <div className="mt-4 flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Apps that already exist</p>
                <p className="text-xs text-muted-foreground">
                  Assign a hostname under{" "}
                  <span className="font-mono">{savedBase}</span> to every service that has
                  none, right now. Custom domains stay as they are.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={backfill}
              disabled={backfilling || dirty}
              title={dirty ? "Save the base domain first" : undefined}
              className="h-10 shrink-0"
            >
              {backfilling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Globe className="h-4 w-4" />
              )}
              Assign now
            </Button>
          </div>
        )}

        {/* What the operator will actually get — rendered from the live draft. */}
        {normalizedBase && templateValid && (
          <div className="mt-4 rounded-xl border border-border/60 bg-secondary/20 px-4 py-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
              An app named “my-app” will be published at
            </p>
            <p className="mt-1 break-all font-mono text-sm font-medium text-foreground">
              {previewScheme}://{preview}
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">DNS records</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Add these at your registrar. Until they resolve, hostnames under{" "}
                <span className="font-mono">{normalizedBase}</span> will not reach this server and
                certificates cannot be issued.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="press h-8 shrink-0 border-border/60"
              disabled={rechecking}
              onClick={async () => {
                setRechecking(true);
                try {
                  const info = await refreshEdgeInfo();
                  const verdicts = [info.dns, info.apexDns].filter(Boolean) as EdgeDns[];
                  if (verdicts.length && verdicts.every((d) => d.verdict === "ok")) {
                    toast.success("DNS is resolving to this server");
                  } else if (verdicts.some((d) => d.verdict === "missing")) {
                    toast.error("Still not found — new records can take a few minutes to spread");
                  } else {
                    toast.message("Re-checked");
                  }
                } finally {
                  setRechecking(false);
                }
              }}
            >
              {rechecking ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Re-check DNS
            </Button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <th className="pb-2 pr-4 font-semibold">Type</th>
                  <th className="pb-2 pr-4 font-semibold">Name</th>
                  <th className="pb-2 pr-4 font-semibold">Value</th>
                  <th className="pb-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                <tr className="border-b border-border/40">
                  <td className="py-2.5 pr-4">A</td>
                  <td className="py-2.5 pr-4">*.{normalizedBase}</td>
                  <td className="py-2.5 pr-4">
                    <CopyValue value={serverIp} />
                  </td>
                  <td className="py-2.5">
                    {isWildcardCoverable(template) ? (
                      <DnsStatus dns={edge.dns} />
                    ) : (
                      <span className="font-sans text-[11px] text-muted-foreground">
                        Not used by this template
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4">A</td>
                  <td className="py-2.5 pr-4">{normalizedBase}</td>
                  <td className="py-2.5 pr-4">
                    <CopyValue value={serverIp} />
                  </td>
                  <td className="py-2.5">
                    <DnsStatus dns={edge.apexDns} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* The single most common cause of "my app URL does not open": the proxy
              is fine, the container is up, and the name simply does not exist. */}
          {edge.dns?.verdict === "missing" && isWildcardCoverable(template) && (
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-mono">*.{normalizedBase}</span> does not exist yet, so every
                app hostname under it returns NXDOMAIN — the apps themselves are running and are
                still reachable on their host port. Add the wildcard record above and re-check.
              </span>
            </p>
          )}
          {edge.dns?.verdict === "elsewhere" && (
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-mono">*.{normalizedBase}</span> resolves to{" "}
                <span className="font-mono">{edge.dns.addresses.slice(0, 2).join(", ")}</span>
                {serverIp ? `, not to ${serverIp}` : ""}. That is expected behind a proxy such as
                Cloudflare; otherwise repoint it here.
              </span>
            </p>
          )}
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
