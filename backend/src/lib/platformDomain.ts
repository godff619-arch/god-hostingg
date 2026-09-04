// The platform's own domain (e.g. godhosting.bond) and the subdomain every user
// app gets under it. An operator sets the base domain once in Admin → Domains;
// from then on any service deployed without a custom hostname is published at
// `<app>.<base-domain>`.
//
// Routing is unchanged: the hostname is written to `Service.domain`, which the
// existing nginx + certbot pipeline already turns into a proxy config and a
// certificate. Nothing in this file talks to Docker or nginx directly.

import prisma from './prisma.js';
import { assertHostnamesAvailable } from './domainOwnership.js';
import { getBoolSetting, getSetting, setBoolSetting, setSetting } from './settings.js';

export const S_BASE_DOMAIN = 'base_domain';
export const S_AUTO_SUBDOMAIN = 'auto_subdomain_enabled';
export const S_SUBDOMAIN_TEMPLATE = 'subdomain_template';

/** `{slug}.{base}` — the only shape a `*.base` wildcard DNS record can cover. */
export const DEFAULT_SUBDOMAIN_TEMPLATE = '{slug}.{base}';

const HOSTNAME_REGEX =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Names an operator nearly always wants for the platform itself, not a tenant. */
const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'panel', 'dashboard', 'mail', 'smtp', 'imap',
  'ns1', 'ns2', 'mx', 'status', 'docs', 'static', 'cdn', 'assets', 'billing',
]);

export interface PlatformDomainConfig {
  /** Bare apex the platform owns, e.g. `godhosting.bond`. Null = feature off. */
  baseDomain: string | null;
  autoSubdomain: boolean;
  template: string;
}

export async function getPlatformDomainConfig(): Promise<PlatformDomainConfig> {
  const [base, template, auto] = await Promise.all([
    getSetting(S_BASE_DOMAIN),
    getSetting(S_SUBDOMAIN_TEMPLATE),
    getBoolSetting(S_AUTO_SUBDOMAIN, true),
  ]);
  return {
    baseDomain: normalizeBaseDomain(base),
    autoSubdomain: auto,
    template: normalizeTemplate(template) ?? DEFAULT_SUBDOMAIN_TEMPLATE,
  };
}

/** Accepts `godhosting.bond`, `*.godhosting.bond`, `https://godhosting.bond/`. */
export function normalizeBaseDomain(input: unknown): string | null {
  let raw = String(input ?? '').trim().toLowerCase();
  raw = raw.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  raw = raw.replace(/^\*\./, '').replace(/\.$/, '');
  if (!raw || !HOSTNAME_REGEX.test(raw)) return null;
  return raw;
}

/**
 * A template must place both placeholders, so the result is always derived from
 * the app name and the base domain. `{slug}.{base}` is the one a wildcard record
 * covers; `{slug}-{base}` is accepted because an operator may own those names,
 * but each one then needs its own DNS record.
 */
export function normalizeTemplate(input: unknown): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!raw.includes('{slug}') || !raw.includes('{base}')) return null;
  if (!/^[a-z0-9{}._-]+$/.test(raw)) return null;
  return raw;
}

/**
 * Lowercase DNS label from a free-text project or service name.
 *
 * Accents are folded rather than punched out: NFKD splits `é` into `e` + a
 * combining mark, and dropping the mark keeps the letter. Without that step every
 * accent would land in the `[^a-z0-9]` bucket and insert a dash, so `Café App`
 * came out as `caf-app`. Letters with no ASCII decomposition (`ø`, CJK) still
 * collapse to a separator — there is no transliteration table here.
 */
export function slugify(input: string): string {
  const slug = String(input ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'app';
}

export function renderSubdomain(template: string, slug: string, base: string): string {
  return template.replace(/\{slug\}/g, slug).replace(/\{base\}/g, base);
}

/** `stem`, then `stem-2`, `stem-3`… so a name clash still resolves. */
function* candidateSlugs(stem: string): Generator<string> {
  if (!RESERVED_SLUGS.has(stem)) yield stem;
  for (let n = 2; n <= 20; n += 1) yield `${stem}-${n}`;
}

interface SubdomainTarget {
  id: string;
  name: string;
  domain: string | null;
}

/**
 * The hostname this service would get, without writing anything. Used by the
 * admin preview so an operator sees the real result before enabling the feature.
 */
export function previewSubdomain(
  projectName: string,
  serviceName: string,
  cfg: Pick<PlatformDomainConfig, 'baseDomain' | 'template'>,
): string | null {
  if (!cfg.baseDomain) return null;
  const host = renderSubdomain(cfg.template, subdomainStem(projectName, serviceName), cfg.baseDomain);
  return HOSTNAME_REGEX.test(host) ? host : null;
}

/** `myapp` for a single-service project, `myapp-worker` when they differ. */
function subdomainStem(projectName: string, serviceName: string): string {
  const projectSlug = slugify(projectName);
  const serviceSlug = slugify(serviceName);
  return serviceSlug === projectSlug ? projectSlug : `${projectSlug}-${serviceSlug}`;
}

/**
 * Give one service a hostname under the base domain. Returns the hostname that
 * was written, or null when nothing changed — a service that already has a
 * custom domain is never touched, so an operator's own mapping always wins.
 */
export async function assignServiceSubdomain(
  service: SubdomainTarget,
  projectName: string,
  cfg?: PlatformDomainConfig,
): Promise<string | null> {
  const config = cfg ?? (await getPlatformDomainConfig());
  if (!config.baseDomain || !config.autoSubdomain) return null;
  if (service.domain && service.domain.trim()) return null;

  const stem = subdomainStem(projectName, service.name);
  for (const candidate of candidateSlugs(stem)) {
    const host = renderSubdomain(config.template, candidate, config.baseDomain);
    if (!HOSTNAME_REGEX.test(host)) continue;
    try {
      await assertHostnamesAvailable([host], { excludeServiceId: service.id });
    } catch {
      continue; // taken by another service or by a panel domain — try the next
    }
    await prisma.service.update({ where: { id: service.id }, data: { domain: host } });
    return host;
  }
  return null;
}

export interface AssignedSubdomain {
  service: string;
  domain: string;
}

/**
 * Called at the start of every deploy: any service in the project that has no
 * hostname gets one under the base domain, so the app is reachable by name
 * instead of `ip:port`. Managed databases are skipped — they are private by
 * design and a public hostname would be the wrong default.
 *
 * Soft-fails: a settings or DNS-bookkeeping problem must never fail a deploy.
 */
export async function ensureProjectSubdomains(projectId: string): Promise<AssignedSubdomain[]> {
  try {
    const config = await getPlatformDomainConfig();
    if (!config.baseDomain || !config.autoSubdomain) return [];

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        project_type: true,
        services: { select: { id: true, name: true, domain: true } },
      },
    });
    if (!project || project.project_type === 'database') return [];

    const assigned: AssignedSubdomain[] = [];
    for (const service of project.services) {
      const host = await assignServiceSubdomain(service, project.name, config);
      if (host) assigned.push({ service: service.name, domain: host });
    }
    return assigned;
  } catch (error) {
    console.error('[platformDomain] subdomain assignment skipped:', error);
    return [];
  }
}

/** Persist the operator's choices. Invalid input is rejected, not silently kept. */
export async function setPlatformDomainConfig(input: {
  base_domain?: unknown;
  auto_subdomain_enabled?: unknown;
  subdomain_template?: unknown;
}): Promise<PlatformDomainConfig> {
  if (input.base_domain !== undefined) {
    const raw = String(input.base_domain ?? '').trim();
    if (raw === '') {
      await setSetting(S_BASE_DOMAIN, '');
    } else {
      const base = normalizeBaseDomain(raw);
      if (!base) throw new Error('Base domain must be a hostname like godhosting.bond');
      await setSetting(S_BASE_DOMAIN, base);
    }
  }
  if (input.subdomain_template !== undefined) {
    const raw = String(input.subdomain_template ?? '').trim();
    if (raw === '') {
      await setSetting(S_SUBDOMAIN_TEMPLATE, DEFAULT_SUBDOMAIN_TEMPLATE);
    } else {
      const template = normalizeTemplate(raw);
      if (!template) {
        throw new Error('Template must contain {slug} and {base}, e.g. {slug}.{base}');
      }
      await setSetting(S_SUBDOMAIN_TEMPLATE, template);
    }
  }
  if (input.auto_subdomain_enabled !== undefined) {
    await setBoolSetting(S_AUTO_SUBDOMAIN, !!input.auto_subdomain_enabled);
  }
  return getPlatformDomainConfig();
}
