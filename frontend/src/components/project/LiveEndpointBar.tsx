// The app's public URL, at the top of the project page where an operator looks
// first. Before this, the only place the endpoint appeared was a line deep in the
// deploy log ("ENDPOINTS: app: http://…"), which nobody scrolls back to find.
//
// Every URL here is derived from real rows: `Service.domain` (comma-separated,
// set by the domains tab or the platform base domain) and `Service.port` (the
// published host port). Nothing is invented — when a service has neither, this
// says so instead of printing a link that would 404.

import { useState } from "react";
import { Check, Copy, ExternalLink, Globe, Plug } from "lucide-react";
import { toast } from "sonner";
import type { Service } from "@/lib/types";
import { cn, copyToClipboard } from "@/lib/utils";

export interface Endpoint {
  /** Absolute URL, safe to put in href. */
  url: string;
  /** What to print — hostname, or `ip:port` for a raw host port. */
  label: string;
  kind: "domain" | "host-port";
  serviceName: string;
}

/**
 * Public endpoints for a set of services, domains first.
 *
 * `serverIP` arrives as `"..."` while `/api/system/ip` is still in flight and
 * `"N/A"` when the probe failed; neither is a routable host, so a host port is
 * only turned into a link once a real address is known.
 */
export function serviceEndpoints(services: Service[], serverIP: string): Endpoint[] {
  const isLocal =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const portHost = isLocal ? "localhost" : serverIP;
  const portHostReady = Boolean(portHost) && portHost !== "..." && portHost !== "N/A";

  const domains: Endpoint[] = [];
  const hostPorts: Endpoint[] = [];

  for (const svc of services) {
    for (const domain of (svc.domain || "").split(",").map((d) => d.trim()).filter(Boolean)) {
      domains.push({
        url: `https://${domain}`,
        label: domain,
        kind: "domain",
        serviceName: svc.name,
      });
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

  // Domains are the safe path (HTTPS, no origin IP on show), so they lead.
  return [...domains, ...hostPorts];
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
  const endpoints = serviceEndpoints(services, serverIP);
  const primary = endpoints[0];
  const rest = endpoints.slice(1);

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
              className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {endpoint.label}
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
