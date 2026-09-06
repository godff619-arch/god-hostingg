// Which proxy owns this host's 80/443, and whether the platform's hostnames
// actually resolve to it — reduced to what a tenant page needs.
//
// Before this, every UI that printed a hostname hardcoded `https://`. That is
// right only where something terminates TLS — our own nginx, or an incumbent
// Traefik that has an ACME resolver. On a host whose proxy has no resolver, or
// which has no proxy on those ports at all, that link is dead on arrival.
//
// `dns` is the other half. A healthy Traefik says nothing about DNS: with no
// `*.base` record every app subdomain is NXDOMAIN, and the project page was
// still calling one of those the app's LIVE URL.
//
// The answer is a property of the host, not of the project, so it is fetched
// once per page load and shared through a module-level promise: ten services on
// a project page make one request, not ten.

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";
import { API_URL } from "@/lib/utils";

export type DnsVerdict = "ok" | "elsewhere" | "missing" | "unknown";

export interface EdgeDns {
  /** `missing` = the name does not exist; `elsewhere` = resolves off this host. */
  verdict: DnsVerdict;
  /** What was probed, e.g. `*.godhosting.cyou`. */
  hostname: string;
  addresses: string[];
  /** This server's public IP, when known. */
  expected: string | null;
  /** The record an operator has to create, ready to read out. */
  record: { type: string; name: string; value: string | null };
}

export interface EdgeInfo {
  /** null = not known; callers keep their previous assumption. */
  mode: "nginx" | "traefik" | "none" | null;
  /** Something terminates TLS for tenant hostnames. */
  https: boolean;
  /** A saved hostname can reach a container at all. */
  serves: boolean;
  /** Platform base domain, so a caller can tell platform hostnames from custom ones. */
  baseDomain: string | null;
  /** Wildcard DNS status for the base domain. Null = nothing to check. */
  dns: EdgeDns | null;
  /** The base domain's own A record — what the panel itself is reached on. */
  apexDns: EdgeDns | null;
  /** The subdomain template cannot be covered by one wildcard record. */
  perAppRecords: boolean;
}

/** Assume the old behaviour until the server answers — never downgrade a live link. */
export const EDGE_UNKNOWN: EdgeInfo = {
  mode: null,
  https: true,
  serves: true,
  baseDomain: null,
  dns: null,
  apexDns: null,
  perAppRecords: false,
};

interface DnsPayload {
  verdict?: unknown;
  hostname?: unknown;
  addresses?: unknown;
  expected?: unknown;
  record?: { type?: unknown; name?: unknown; value?: unknown };
}

interface EdgePayload {
  mode?: unknown;
  https?: unknown;
  serves?: unknown;
  base_domain?: unknown;
  dns?: DnsPayload | null;
  dns_apex?: DnsPayload | null;
  per_app_records?: unknown;
}

const VERDICTS: DnsVerdict[] = ["ok", "elsewhere", "missing", "unknown"];

/**
 * A verdict we do not recognise must not read as "missing" and strike a live link
 * off the page, so anything unexpected collapses to no DNS opinion at all.
 */
function parseDns(raw: DnsPayload | null | undefined): EdgeDns | null {
  const verdict = VERDICTS.find((v) => v === raw?.verdict);
  if (!raw || !verdict) return null;
  return {
    verdict,
    hostname: typeof raw.hostname === "string" ? raw.hostname : "",
    addresses: Array.isArray(raw.addresses) ? raw.addresses.map(String) : [],
    expected: typeof raw.expected === "string" ? raw.expected : null,
    record: {
      type: typeof raw.record?.type === "string" ? raw.record.type : "A",
      name: typeof raw.record?.name === "string" ? raw.record.name : "",
      value: typeof raw.record?.value === "string" ? raw.record.value : null,
    },
  };
}

function parse(data: EdgePayload): EdgeInfo {
  const mode =
    data.mode === "nginx" || data.mode === "traefik" || data.mode === "none" ? data.mode : null;
  return {
    mode,
    https: data.https !== false,
    serves: data.serves !== false,
    baseDomain: typeof data.base_domain === "string" ? data.base_domain : null,
    dns: parseDns(data.dns),
    apexDns: parseDns(data.dns_apex),
    perAppRecords: data.per_app_records === true,
  };
}

let inFlight: Promise<EdgeInfo> | null = null;
let cached: EdgeInfo | null = null;
const subscribers = new Set<(info: EdgeInfo) => void>();

async function load(refresh = false): Promise<EdgeInfo> {
  try {
    const res = await authFetch(`${API_URL}/api/system/edge${refresh ? "?refresh=1" : ""}`);
    if (!res.ok) return EDGE_UNKNOWN;
    return parse((await res.json()) as EdgePayload);
  } catch {
    return EDGE_UNKNOWN;
  }
}

/** Drop the cache so a page can re-probe after an operator changes the edge. */
export function invalidateEdgeInfo(): void {
  cached = null;
  inFlight = null;
}

/**
 * Force a fresh probe on the server (proxy *and* DNS) and push it to every
 * mounted `useEdgeInfo`. Used by the admin domain page's re-check button: an
 * operator who has just created the record should not have to reload the app to
 * see it recognised.
 */
export async function refreshEdgeInfo(): Promise<EdgeInfo> {
  const info = await load(true);
  cached = info;
  inFlight = Promise.resolve(info);
  subscribers.forEach((notify) => notify(info));
  return info;
}

export function useEdgeInfo(): EdgeInfo {
  const [edge, setEdge] = useState<EdgeInfo>(cached ?? EDGE_UNKNOWN);

  useEffect(() => {
    let alive = true;
    const notify = (info: EdgeInfo) => {
      if (alive) setEdge(info);
    };
    subscribers.add(notify);
    if (cached) {
      setEdge(cached);
    } else {
      inFlight ??= load();
      void inFlight.then((result) => {
        cached = result;
        notify(result);
      });
    }
    return () => {
      alive = false;
      subscribers.delete(notify);
    };
  }, []);

  return edge;
}
