// The app's public URL, at the top of the project page where an operator looks
// first. Before this, the only place the endpoint appeared was a line deep in the
// deploy log ("ENDPOINTS: app: http://…"), which nobody scrolls back to find.
//
// Every URL here is derived from real rows: `Service.domain` (comma-separated,
// set by the domains tab or the platform base domain) and `Service.port` (the
// published host port). Nothing is invented — when a service has neither, this
// says so instead of printing a link that would 404.
//
// "Live" also has to mean live: a hostname is only offered as the primary URL
// once something serves 80/443 *and* the name resolves to this host. Otherwise
// the working host port leads and the hostname carries the reason it does not.

import { useState } from "react";
import { Check, Copy, ExternalLink, Globe, Plug } from "lucide-react";
import { toast } from "sonner";
import { EDGE_UNKNOWN, useEdgeInfo, type EdgeInfo } from "@/hooks/useEdgeInfo";
import type { Service } from "@/lib/types";
import { cn, copyToClipboard } from "@/lib/utils";

export type BlockReason = "no-proxy" | "dns-missing" | "dns-elsewhere";

export interface Endpoint {
  /** Absolute URL, safe to put in href. */
  url: string;
  /** What to print — hostname, or `ip:port` for a raw host port. */
  label: string;
  kind: "domain" | "host-port";
  serviceName: string;
  /**
   * Why this URL cannot answer yet, when it cannot. Printed rather than hidden —
   * an operator who added the hostname needs to know what is still missing, and
   * a blocked hostname must never be the one shown as the app's live URL.
   */
  blocked?: BlockReason;
}

/** True when `host` is the platform base domain or a subdomain of it. */
function underBase(host: string, base: string | null): boolean {
  if (!base) return false;
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Public endpoints for a set of services, working ones first.
 *
 * `serverIP` arrives as `"..."` while `/api/system/ip` is still in flight and
 * `"N/A"` when the probe failed; neither is a routable host, so a host port is
 * only turned into a link once a real address is known.
 *
 * `edge` decides the scheme and whether a hostname can work at all. `https://`
 * is only correct where something terminates TLS for tenant hostnames; on a host
 * whose proxy has no certificate resolver the same URL is a dead link, so plain
 * HTTP is printed instead. A hostname whose DNS does not exist is worse than
 * either — it cannot be reached by anyone — so it is pushed below the host port
 * and labelled, never presented as the live URL.
 */
export function serviceEndpoints(
  services: Service[],
  serverIP: string,
  edge: EdgeInfo = EDGE_UNKNOWN,
): Endpoint[] {
  const isLocal =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const portHost = isLocal ? "localhost" : serverIP;
  const portHostReady = Boolean(portHost) && portHost !== "..." && portHost !== "N/A";
  const scheme = edge.https ? "https" : "http";

  const domains: Endpoint[] = [];
  const blockedDomains: Endpoint[] = [];
  const hostPorts: Endpoint[] = [];

  for (const svc of services) {
    for (const domain of (svc.domain || "").split(",").map((d) => d.trim()).filter(Boolean)) {
      // DNS is only judged for hostnames the platform issued: a custom domain is
      // the tenant's own record and we have not probed it, so claiming it is
      // broken would be a guess.
      const platform = underBase(domain, edge.baseDomain);
      const dns = platform ? edge.dns?.verdict : undefined;
      const blocked: BlockReason | undefined = !edge.serves
        ? "no-proxy"
        : dns === "missing"
          ? "dns-missing"
          : dns === "elsewhere"
            ? "dns-elsewhere"
            : undefined;
      const endpoint: Endpoint = {
        url: `${scheme}://${domain}`,
        label: domain,
        kind: "domain",
        serviceName: svc.name,
        blocked,
      };
      // `elsewhere` still resolves somewhere, and behind Cloudflare that is the
      // normal answer, so it keeps its place in the list and only gets a note.
      (blocked === "no-proxy" || blocked === "dns-missing" ? blockedDomains : domains).push(
        endpoint,
      );
    }
    const hasHostPort = typeof svc.port === "number" && Number.isFinite(svc.port) && svc.port > 0;
    if (hasHostPort && portHostReady) {
      hostPorts.push({
        url: `http://${portHost}:${svc.port}`,
        label: `${portHost}:${svc.port}`,
        kind: "host-port",
        serviceName: svc.name,
      });
    }
  }

  // Domains are the safe path (HTTPS, no origin IP on show), so working ones
  // lead. A hostname that cannot answer goes last: the host port is then the
  // address that actually serves the app, and leading with a dead name — which
  // is exactly what shipped before — makes the product look broken.
  return [...domains, ...hostPorts, ...blockedDomains];
}

interface LiveEndpointBarProps {
  services: Service[];
  serverIP: string;
  /** Project status — a link is only worth clicking when something is serving. */
  status?: string;
  /** Jump to the domains tab from the empty state. */
  onAddDomain?: () => void;
  className?: string;
}

export function LiveEndpointBar({
  services,
  serverIP,
  status,
  onAddDomain,
  className,
}: LiveEndpointBarProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const edge = useEdgeInfo();
  const endpoints = serviceEndpoints(services, serverIP, edge);
  const primary = endpoints[0];
  const rest = endpoints.slice(1);
  /** Hostnames that are saved but cannot answer yet, grouped below by cause. */
  const blocked = endpoints.filter((e) => e.blocked);

  const copy = async (url: string) => {
    const ok = await copyToClipboard(url);
    if (!ok) {
      toast.error("Could not copy the URL");
      return;
    }
    setCopied(url);
    toast.success("URL copied");
    window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1600);
  };

  if (!primary) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-3",
          className,
        )}
      >
        <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs text-muted-foreground sm:text-[13px]">
          No public URL yet — this project is only reachable inside its Docker network.
        </p>
        {onAddDomain && (
          <button
            type="button"
            onClick={onAddDomain}
            className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Add domain
          </button>
        )}
      </div>
    );
  }

  const live = status === "running" || status === "degraded";

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card px-4 py-3 sm:px-5 sm:py-3.5",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
              live
                ? "border-success-border bg-success-surface text-success"
                : "border-border bg-secondary/40 text-muted-foreground",
            )}
          >
            <Globe className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
              {live ? "Live URL" : "App URL"}
              {primary.kind === "host-port" && " · host port"}
            </p>
            <a
              href={primary.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-mono text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:text-brand hover:decoration-brand sm:text-base"
            >
              {primary.label}
            </a>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => copy(primary.url)}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            {copied === primary.url ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied === primary.url ? "Copied" : "Copy"}
          </button>
          <a
            href={primary.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 items-center gap-1.5 rounded-lg border border-transparent bg-brand px-3.5 text-xs font-semibold text-brand-foreground transition-[filter] hover:brightness-110"
          >
            Open
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {rest.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-[0.09em] text-subtle">
            Also on
          </span>
          {rest.map((endpoint) => (
            <a
              key={endpoint.url}
              href={endpoint.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${endpoint.serviceName} · ${endpoint.kind === "domain" ? "domain" : "host port"}`}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                endpoint.blocked && "border-dashed opacity-70",
              )}
            >
              {endpoint.label}
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
            </a>
          ))}
        </div>
      )}

      {/* A hostname with nothing behind it looks identical to a working one, so
          say which half is missing — and for DNS, exactly which record to add. */}
      <EndpointBlockers
        blocked={blocked}
        edge={edge}
        hasHostPort={endpoints.some((e) => e.kind === "host-port")}
      />
    </div>
  );
}

/**
 * Why the saved hostnames do not answer. Two very different failures used to
 * share one sentence about reverse proxies: a missing DNS record is not a proxy
 * problem, and telling an operator to install a proxy they already have is how a
 * five-second fix turns into an afternoon.
 */
function EndpointBlockers({
  blocked,
  edge,
  hasHostPort,
}: {
  blocked: Endpoint[];
  edge: EdgeInfo;
  hasHostPort: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (blocked.length === 0) return null;

  const named = (list: Endpoint[]) =>
    list.length === 1 ? `${list[0].label} is` : `${list.length} hostnames are`;
  const noProxy = blocked.filter((e) => e.blocked === "no-proxy");
  const dnsMissing = blocked.filter((e) => e.blocked === "dns-missing");
  const dnsElsewhere = blocked.filter((e) => e.blocked === "dns-elsewhere");
  const record = edge.dns?.record;
  const target = record?.value;

  const copyRecord = async () => {
    if (!record?.name || !target) return;
    const ok = await copyToClipboard(`${record.name} ${record.type} ${target}`);
    if (!ok) {
      toast.error("Could not copy the record");
      return;
    }
    setCopied(true);
    toast.success("DNS record copied");
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
      {noProxy.length > 0 && (
        <p className="text-[11px] leading-relaxed text-warning">
          {named(noProxy)} saved but not served yet — no reverse proxy owns port 80/443 on this
          server.
          {hasHostPort
            ? " The host port above works in the meantime."
            : " Publish a host port on the service, or put a reverse proxy in front of this server."}
        </p>
      )}

      {dnsMissing.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-relaxed text-warning">
            {named(dnsMissing)} routed by this server, but the name does not exist in DNS yet, so
            nobody can reach it.
            {edge.baseDomain && !edge.perAppRecords
              ? ` One wildcard record covers every app under ${edge.baseDomain}:`
              : " Point it at this server:"}
            {hasHostPort && !edge.baseDomain ? " The host port above works in the meantime." : ""}
          </p>
          {record?.name && target ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-border bg-secondary/40 px-2 py-1 font-mono text-[11px] text-foreground">
                {record.name} {record.type} {target}
              </code>
              <button
                type="button"
                onClick={copyRecord}
                className="press flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary"
              >
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy record"}
              </button>
              {hasHostPort && (
                <span className="text-[11px] text-muted-foreground">
                  The host port above works in the meantime.
                </span>
              )}
            </div>
          ) : null}
          {edge.perAppRecords && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The subdomain template is not <code className="font-mono">{"{slug}.{base}"}</code>, so
              a wildcard cannot cover it — each app needs its own record.
            </p>
          )}
        </div>
      )}

      {dnsElsewhere.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {named(dnsElsewhere)} resolving to{" "}
          <span className="font-mono">{edge.dns?.addresses.slice(0, 2).join(", ")}</span>, not this
          server{edge.dns?.expected ? ` (${edge.dns.expected})` : ""}. That is normal behind a proxy
          such as Cloudflare; otherwise repoint the record here.
        </p>
      )}
    </div>
  );
}
