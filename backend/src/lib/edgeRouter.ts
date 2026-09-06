// Which reverse proxy owns :80/:443 on this host — and therefore how a user app
// becomes reachable by hostname.
//
// Three hosts, three answers:
//
//   nginx    The docker-compose control plane is running, so `docklift-nginx-proxy`
//            exists and God Hosting owns the edge. Hostnames are served from
//            generated vhosts and certbot issues the certificates.
//
//   traefik  Something else already owns 80/443 — on a Coolify VPS that is its
//            Traefik. Fighting it for the port is not an option, so instead each
//            app container is *labelled* for Traefik and joined to Traefik's
//            network. Traefik then routes the hostname and issues the certificate
//            with its own ACME resolver. No vhost, no certbot, no port conflict.
//
//   none     No edge at all (bare `npm run dev`, or a host whose proxy we cannot
//            see). Apps are reachable on their published host port only, and a
//            saved hostname stays inactive until an edge exists. This is reported
//            honestly rather than papered over.
//
// Detection is cached briefly: it costs two Docker API calls and is consulted on
// every deploy and every domain save.

import Docker from 'dockerode';
import { EDGE_PROXY_CONTAINER } from '../services/docker.js';

const docker = new Docker();

export type EdgeMode = 'nginx' | 'traefik' | 'none';

export interface EdgeRouter {
  mode: EdgeMode;
  /** Container that owns the edge, for logs and the admin diagnostics panel. */
  container: string | null;
  /** Network app containers must join to be reachable by the edge (traefik only). */
  network: string | null;
  /** Traefik ACME resolver name, when it has one configured. */
  certResolver: string | null;
  /** Traefik entrypoint names for plain HTTP and TLS. */
  entrypoints: { http: string; https: string };
  /** One line an operator can act on. */
  reason: string;
}

const NONE: EdgeRouter = {
  mode: 'none',
  container: null,
  network: null,
  certResolver: null,
  entrypoints: { http: 'http', https: 'https' },
  reason:
    'No edge proxy found on this host — apps are reachable on their published host port only.',
};

/** Coolify names them `http`/`https`; upstream Traefik samples use `web`/`websecure`. */
const HTTP_ENTRYPOINT_FALLBACKS = ['http', 'web'];
const HTTPS_ENTRYPOINT_FALLBACKS = ['https', 'websecure'];

let cache: { at: number; value: EdgeRouter } | null = null;
const TTL_MS = 30_000;

export function invalidateEdgeRouter(): void {
  cache = null;
}

/**
 * Resolve the edge for this host. Never throws: an unreachable Docker daemon is a
 * `none` edge, which is exactly how a host with no Docker behaves anyway.
 */
export async function detectEdgeRouter(opts?: { refresh?: boolean }): Promise<EdgeRouter> {
  if (!opts?.refresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: EdgeRouter;
  try {
    value = (await probeOwnNginx()) ?? (await probeTraefik()) ?? NONE;
  } catch (err) {
    value = {
      ...NONE,
      reason: `Could not inspect this host's containers (${
        (err as Error)?.message || 'Docker unreachable'
      }) — treating the host as having no edge proxy.`,
    };
  }
  cache = { at: Date.now(), value };
  return value;
}

async function probeOwnNginx(): Promise<EdgeRouter | null> {
  try {
    const info = await docker.getContainer(EDGE_PROXY_CONTAINER).inspect();
    if (!info?.State?.Running) return null;
    return {
      mode: 'nginx',
      container: EDGE_PROXY_CONTAINER,
      network: null,
      certResolver: null,
      entrypoints: { http: 'http', https: 'https' },
      reason: `God Hosting's own nginx edge (${EDGE_PROXY_CONTAINER}) is running — it serves custom domains and certbot issues the certificates.`,
    };
  } catch {
    return null;
  }
}

/**
 * Find a running Traefik and read its own configuration rather than assuming it.
 *
 * The three facts that matter are the network it can reach containers on, the
 * entrypoint names, and whether it has an ACME resolver. Guessing any of them
 * produces labels Traefik silently ignores, which is the worst failure mode
 * available: a green deploy and a dead hostname.
 */
async function probeTraefik(): Promise<EdgeRouter | null> {
  const containers = await docker.listContainers({ filters: { status: ['running'] } });
  const candidate = containers.find((c) => {
    const image = (c.Image || '').toLowerCase();
    const names = (c.Names || []).join(' ').toLowerCase();
    return image.includes('traefik') || names.includes('traefik') || names.includes('coolify-proxy');
  });
  if (!candidate) return null;

  const info = await docker.getContainer(candidate.Id).inspect();
  const name = (info.Name || '').replace(/^\//, '');
  const cmd: string[] = [
    ...(Array.isArray(info.Config?.Entrypoint) ? info.Config.Entrypoint : []),
    ...(Array.isArray(info.Config?.Cmd) ? info.Config.Cmd : []),
  ].map(String);
  const argv = cmd.join(' ');

  // The port claim is what makes this an *edge*: a Traefik with nothing published
  // is somebody's internal mesh and routing a tenant hostname through it would not
  // reach the internet.
  const ports = Object.keys(info.NetworkSettings?.Ports ?? {});
  const bindings = info.HostConfig?.PortBindings ?? {};
  const ownsPort = (port: string) =>
    Object.keys(bindings).some((p) => p.startsWith(`${port}/`)) ||
    ports.some((p) => p.startsWith(`${port}/`));
  if (!ownsPort('80') && !ownsPort('443')) return null;

  const networks = Object.keys(info.NetworkSettings?.Networks ?? {}).filter(
    (n) => n !== 'bridge' && n !== 'host' && n !== 'none',
  );
  // Prefer the network Traefik was told to use for service discovery.
  const declared = /--providers\.docker\.network[= ]([\w.-]+)/.exec(argv)?.[1];
  const network = (declared && networks.includes(declared) ? declared : networks[0]) ?? null;
  if (!network) return null;

  const certResolver = /--certificatesresolvers\.([\w-]+)\.acme/.exec(argv)?.[1] ?? null;
  const entrypoints = {
    http: entrypointFor(argv, ':80', HTTP_ENTRYPOINT_FALLBACKS),
    https: entrypointFor(argv, ':443', HTTPS_ENTRYPOINT_FALLBACKS),
  };

  return {
    mode: 'traefik',
    container: name || candidate.Id.slice(0, 12),
    network,
    certResolver,
    entrypoints,
    reason:
      `${name || 'Traefik'} already owns this host's 80/443, so apps are published through it: ` +
      `each container is labelled for Traefik and joined to "${network}"` +
      (certResolver
        ? `, and Traefik issues the certificate with its "${certResolver}" resolver.`
        : '. Traefik has no ACME resolver configured, so hostnames serve plain HTTP until one is.'),
  };
}

/** `--entrypoints.https.address=:443` → `https`. Falls back to the usual names. */
function entrypointFor(argv: string, address: string, fallbacks: string[]): string {
  const re = new RegExp(`--entrypoints\\.([\\w-]+)\\.address[= ]${address}`);
  const found = re.exec(argv)?.[1];
  if (found) return found;
  for (const name of fallbacks) {
    if (argv.includes(`--entrypoints.${name}.`)) return name;
  }
  return fallbacks[0];
}

/**
 * What to tell the user after a hostname is saved. The three modes differ in what
 * happens next, and saying "domain added" for all of them is how a dead link ships.
 */
export function activationNote(edge: EdgeRouter, hostnames: string[]): string {
  const list = hostnames.join(', ');
  if (!hostnames.length) return 'No hostname mapped.';
  switch (edge.mode) {
    case 'nginx':
      return `${list} is served by ${edge.container}; HTTPS follows as soon as Let's Encrypt validates it.`;
    case 'traefik':
      return `${list} is routed by ${edge.container}. Redeploy this service to publish the routing labels${
        edge.certResolver ? ' and request the certificate' : ''
      }.`;
    default:
      return `${list} is saved but not routed: this host has no edge proxy on 80/443 yet.`;
  }
}
