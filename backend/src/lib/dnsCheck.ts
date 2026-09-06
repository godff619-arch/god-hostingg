// Does a hostname actually resolve to this server?
//
// `edgeRouter.ts` answers "is there a proxy on 80/443". That is only half of what
// makes an app reachable by name, and the missing half is the one that bit us: on
// a host whose base domain has no wildcard record, every app subdomain is
// NXDOMAIN while Traefik sits there perfectly healthy. The panel printed
// `god-gateaway-app.godhosting.cyou` as the LIVE URL and pushed the working
// `ip:port` into a footnote — a green deploy and a dead link.
//
// Resolution is asked of a public resolver, not the host's own, because the
// question is "what does a visitor get". A container's resolver is Docker's
// embedded one and can answer differently from the internet.

import { Resolver } from 'node:dns/promises';

/**
 * `ok`        resolves here (or resolves, and we have no IP to compare against)
 * `elsewhere` resolves, but not to this server — normal behind Cloudflare's proxy
 * `missing`   the name does not exist: no record has been created
 * `unknown`   the lookup itself failed; claim nothing
 */
export type DnsVerdict = 'ok' | 'elsewhere' | 'missing' | 'unknown';

export interface DnsCheck {
  hostname: string;
  verdict: DnsVerdict;
  addresses: string[];
  /** This server's public IP, when known. */
  expected: string | null;
}

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const LOOKUP_TIMEOUT_MS = 3_000;
const TTL_MS = 60_000;

/**
 * c-ares' own budget per query. Without it a nameserver that simply stops
 * answering — which is what AAAA lookups on some zones do — holds the socket
 * open for the library's default 5s × 4 tries, long past any deadline we set.
 */
const RESOLVER_OPTS = { timeout: 1_200, tries: 2 } as const;

/** Codes that mean "this name has no address", as opposed to "the lookup broke". */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

const cache = new Map<string, { at: number; value: DnsCheck }>();

export function invalidateDnsCache(): void {
  cache.clear();
}

type Attempt = { addresses: string[] } | { code: string };

async function attempt(run: () => Promise<string[]>): Promise<Attempt> {
  try {
    return { addresses: await run() };
  } catch (err) {
    return { code: (err as NodeJS.ErrnoException)?.code || 'EFAIL' };
  }
}

/**
 * Resolve A and AAAA through one resolver. `null` = the resolver itself failed.
 *
 * Each record type gets its own deadline. Sharing one would mean a zone that
 * never answers AAAA — common, and exactly what `godhosting.cyou` does — throws
 * away the A answer that arrived in 40ms and reports `unknown`.
 */
async function query(resolver: Resolver, hostname: string): Promise<string[] | null> {
  const timedOut: Attempt = { code: 'ETIMEOUT' };
  const [v4, v6] = await Promise.all([
    withTimeout(attempt(() => resolver.resolve4(hostname)), timedOut),
    withTimeout(attempt(() => resolver.resolve6(hostname)), timedOut),
  ]);
  const addresses = [
    ...('addresses' in v4 ? v4.addresses : []),
    ...('addresses' in v6 ? v6.addresses : []),
  ];
  if (addresses.length) return addresses;
  // Both legs failed. NXDOMAIN/ENODATA is a real answer — the name has no
  // address. Anything else (SERVFAIL, refused, timeout) tells us nothing.
  const codes = [v4, v6].map((r) => ('code' in r ? r.code : '')).filter(Boolean);
  return codes.every((code) => ABSENT_CODES.has(code)) ? [] : null;
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Resolve `hostname` and judge it against this server's public IP.
 *
 * Never throws and never blocks a page for long: a hung resolver becomes
 * `unknown` after three seconds, which reads as "not verified" in the UI rather
 * than as a failure.
 */
export async function checkDns(
  hostname: string,
  expected: string | null,
  opts?: { refresh?: boolean },
): Promise<DnsCheck> {
  const key = `${hostname}|${expected ?? ''}`;
  const hit = cache.get(key);
  if (!opts?.refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const publicResolver = new Resolver(RESOLVER_OPTS);
  publicResolver.setServers(PUBLIC_RESOLVERS);
  let addresses = await withTimeout(query(publicResolver, hostname), null);
  // Outbound 53 is blocked on some hosts. Fall back to whatever the host uses,
  // so a locked-down VPS reports a real answer instead of a permanent `unknown`.
  if (addresses === null) {
    addresses = await withTimeout(query(new Resolver(RESOLVER_OPTS), hostname), null);
  }

  let verdict: DnsVerdict;
  if (addresses === null) verdict = 'unknown';
  else if (addresses.length === 0) verdict = 'missing';
  else if (!expected) verdict = 'ok';
  else verdict = addresses.includes(expected) ? 'ok' : 'elsewhere';

  const value: DnsCheck = { hostname, verdict, addresses: addresses ?? [], expected };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Is there a wildcard record under `base`?
 *
 * Probed with a label nobody would ever create, so a hit can only come from a
 * wildcard — checking `www.base` would pass on a hand-made record and still leave
 * every app subdomain dead. The result is cached under the base domain, not under
 * the throwaway label.
 */
export async function checkWildcardDns(
  base: string,
  expected: string | null,
  opts?: { refresh?: boolean },
): Promise<DnsCheck> {
  const key = `*.${base}|${expected ?? ''}`;
  const hit = cache.get(key);
  if (!opts?.refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const label = `dl-probe-${Math.random().toString(36).slice(2, 10)}`;
  const probe = await checkDns(`${label}.${base}`, expected, { refresh: true });
  const value: DnsCheck = { ...probe, hostname: `*.${base}` };
  cache.set(key, { at: Date.now(), value });
  return value;
}
