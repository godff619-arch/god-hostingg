/**
 * Blueprint parsing + apply (Part A → Blueprints).
 *
 * A blueprint is Docklift's infrastructure-as-code: a `docklift.yaml`-shaped spec
 * listing services and managed databases. Applying it creates the *real*
 * resources in a chosen project group + environment — the same rows the New
 * Project / New Database flows create, through the same code paths, so quotas and
 * validation cannot be side-stepped by going through a blueprint.
 *
 * Honesty rules this file keeps:
 * - Parsing is strict. An unknown key or a bad value is reported as a spec error,
 *   never silently coerced into something that "works".
 * - Every item's outcome is recorded individually. A run where two services were
 *   created and one failed is `partial` with the failing reason in the log — it is
 *   never reported as a success.
 * - Nothing is deployed here. Creating a resource is not the same as running it,
 *   so the apply says "created (not deployed yet)" and leaves the deploy to the
 *   user (or to auto-deploy, if the spec asked for it).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import prisma from './prisma.js';
import { config } from './config.js';
import { cloneRepo } from '../services/git.js';
import { normalizeBuildType } from '../services/buildResolver.js';
import { isValidEnvKey } from './envVariables.js';
import { provisionDatabase } from './databaseProvision.js';
import { assertCanCreateApp } from './quota.js';
import { isDatabaseEngineId, listDatabaseEngines } from './databaseEngines.js';
import crypto from 'crypto';

/** Service kinds a blueprint may declare. All three are app projects today. */
export const SERVICE_TYPES = ['web', 'private', 'worker'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SPEC_FORMATS = ['yaml', 'json'] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

export interface SpecEnvVar {
  key: string;
  value: string;
}

export interface SpecService {
  name: string;
  type: ServiceType;
  repo: string;
  branch: string | null;
  /** auto | dockerfile | … — normalized by the existing build resolver. */
  build: string;
  rootDir: string;
  dockerfilePath: string | null;
  port: number;
  domain: string | null;
  autoDeploy: boolean;
  envVars: SpecEnvVar[];
}

export interface SpecDatabase {
  name: string;
  engine: string;
  version: string | null;
}

export interface ParsedSpec {
  services: SpecService[];
  databases: SpecDatabase[];
  /** Non-empty means the spec is unusable; the apply refuses to start. */
  errors: string[];
}

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,119}$/;

const SERVICE_KEYS = new Set([
  'name',
  'type',
  'repo',
  'branch',
  'build',
  'rootDir',
  'dockerfilePath',
  'port',
  'domain',
  'autoDeploy',
  'envVars',
]);
const DATABASE_KEYS = new Set(['name', 'engine', 'version']);
const ROOT_KEYS = new Set(['services', 'databases', 'version']);

/** A https git URL. Blueprints accept any https host, unlike the GitHub-only UI. */
function isHttpsGitUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname && u.pathname.replace(/\/+$/, '').length > 1;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The starter spec offered in the UI — real keys only, nothing decorative. */
export function exampleSpec(): string {
  return [
    '# Docklift blueprint. Applying this creates the resources below in the',
    '# project and environment you pick — nothing is deployed until you deploy it.',
    'services:',
    '  - name: web',
    '    type: web',
    '    repo: https://github.com/render-examples/express-hello-world',
    '    branch: main',
    '    port: 3000',
    '    build: auto',
    '    envVars:',
    '      - key: NODE_ENV',
    '        value: production',
    '',
    'databases:',
    '  - name: web-db',
    '    engine: postgres',
    '',
  ].join('\n');
}

/**
 * Parse and validate a spec. Never throws: a malformed document comes back as a
 * single error so the caller can show it next to the editor.
 */
export function parseSpec(text: string, format: string): ParsedSpec {
  const errors: string[] = [];
  const services: SpecService[] = [];
  const databases: SpecDatabase[] = [];

  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) {
    return { services, databases, errors: ['The spec is empty.'] };
  }

  let doc: unknown;
  try {
    doc = format === 'json' ? JSON.parse(raw) : yaml.load(raw);
  } catch (err) {
    const message = (err as Error)?.message || 'could not be parsed';
    return { services, databases, errors: [`The spec is not valid ${format === 'json' ? 'JSON' : 'YAML'}: ${message}`] };
  }

  const root = asRecord(doc);
  if (!root) {
    return {
      services,
      databases,
      errors: ['The spec must be a mapping with a `services` and/or `databases` list.'],
    };
  }

  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) {
      errors.push(`Unknown top-level key \`${key}\`. Supported: services, databases, version.`);
    }
  }

  const rawServices = root.services;
  if (rawServices !== undefined) {
    if (!Array.isArray(rawServices)) {
      errors.push('`services` must be a list.');
    } else {
      rawServices.forEach((entry, index) => {
        const where = `services[${index}]`;
        const item = asRecord(entry);
        if (!item) {
          errors.push(`${where} must be a mapping.`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!SERVICE_KEYS.has(key)) {
            errors.push(`${where}: unknown key \`${key}\`.`);
          }
        }

        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!NAME_RE.test(name)) {
          errors.push(`${where}.name must be 1–120 characters of letters, digits, spaces, - or _.`);
        }

        const type = typeof item.type === 'string' ? item.type.trim() : 'web';
        if (!(SERVICE_TYPES as readonly string[]).includes(type)) {
          errors.push(`${where}.type must be one of: ${SERVICE_TYPES.join(', ')}.`);
        }

        const repo = typeof item.repo === 'string' ? item.repo.trim() : '';
        if (!repo || !isHttpsGitUrl(repo)) {
          errors.push(`${where}.repo must be an https Git URL — a blueprint has no upload to attach.`);
        }

        const branch =
          typeof item.branch === 'string' && item.branch.trim() ? item.branch.trim() : null;
        if (branch && !/^[\w./-]{1,255}$/.test(branch)) {
          errors.push(`${where}.branch contains characters a Git ref cannot hold.`);
        }

        const port = item.port === undefined ? 3000 : Number(item.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`${where}.port must be an integer between 1 and 65535.`);
        }

        const domain =
          typeof item.domain === 'string' && item.domain.trim() ? item.domain.trim() : null;
        if (domain && !DOMAIN_RE.test(domain)) {
          errors.push(`${where}.domain must be a hostname such as api.example.com.`);
        }

        if (item.autoDeploy !== undefined && typeof item.autoDeploy !== 'boolean') {
          errors.push(`${where}.autoDeploy must be true or false.`);
        }

        const rootDir =
          typeof item.rootDir === 'string' && item.rootDir.trim() ? item.rootDir.trim() : '.';
        if (rootDir.includes('..')) {
          errors.push(`${where}.rootDir cannot contain "..".`);
        }

        const dockerfilePath =
          typeof item.dockerfilePath === 'string' && item.dockerfilePath.trim()
            ? item.dockerfilePath.trim()
            : null;
        if (dockerfilePath && dockerfilePath.includes('..')) {
          errors.push(`${where}.dockerfilePath cannot contain "..".`);
        }

        const envVars: SpecEnvVar[] = [];
        if (item.envVars !== undefined) {
          if (!Array.isArray(item.envVars)) {
            errors.push(`${where}.envVars must be a list of { key, value }.`);
          } else {
            item.envVars.forEach((rawVar, varIndex) => {
              const varWhere = `${where}.envVars[${varIndex}]`;
              const entryRecord = asRecord(rawVar);
              if (!entryRecord) {
                errors.push(`${varWhere} must be a mapping with key and value.`);
                return;
              }
              const key = typeof entryRecord.key === 'string' ? entryRecord.key.trim() : '';
              if (!isValidEnvKey(key)) {
                errors.push(`${varWhere}.key is not a valid environment variable name.`);
                return;
              }
              const value = entryRecord.value;
              if (value !== null && typeof value === 'object') {
                errors.push(`${varWhere}.value must be a scalar.`);
                return;
              }
              envVars.push({ key, value: value === null || value === undefined ? '' : String(value) });
            });
          }
        }

        services.push({
          name,
          type: (SERVICE_TYPES as readonly string[]).includes(type) ? (type as ServiceType) : 'web',
          repo,
          branch,
          build: normalizeBuildType(typeof item.build === 'string' ? item.build : undefined),
          rootDir,
          dockerfilePath,
          port: Number.isInteger(port) ? port : 3000,
          domain,
          autoDeploy: item.autoDeploy === true,
          envVars,
        });
      });
    }
  }

  const rawDatabases = root.databases;
  if (rawDatabases !== undefined) {
    if (!Array.isArray(rawDatabases)) {
      errors.push('`databases` must be a list.');
    } else {
      rawDatabases.forEach((entry, index) => {
        const where = `databases[${index}]`;
        const item = asRecord(entry);
        if (!item) {
          errors.push(`${where} must be a mapping.`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!DATABASE_KEYS.has(key)) {
            errors.push(`${where}: unknown key \`${key}\`.`);
          }
        }
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!NAME_RE.test(name)) {
          errors.push(`${where}.name must be 1–120 characters of letters, digits, spaces, - or _.`);
        }
        const engine = typeof item.engine === 'string' ? item.engine.trim() : '';
        if (!isDatabaseEngineId(engine)) {
          errors.push(
            `${where}.engine must be one of: ${listDatabaseEngines().map((e) => e.id).join(', ')}.`,
          );
        }
        const version =
          typeof item.version === 'string' && item.version.trim()
            ? item.version.trim()
            : item.version === undefined || item.version === null
              ? null
              : String(item.version);
        databases.push({ name, engine, version });
      });
    }
  }

  if (!errors.length && !services.length && !databases.length) {
    errors.push('The spec declares no services and no databases — there is nothing to create.');
  }

  // A duplicate name inside one spec would create two resources you cannot tell
  // apart, so it is rejected up front rather than half-applied.
  const seen = new Map<string, string>();
  for (const item of [
    ...services.map((s) => ({ name: s.name, kind: 'service' })),
    ...databases.map((d) => ({ name: d.name, kind: 'database' })),
  ]) {
    const key = item.name.toLowerCase();
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) {
      errors.push(`\`${item.name}\` is declared twice (as ${previous} and ${item.kind}).`);
    } else {
      seen.set(key, item.kind);
    }
  }

  return { services, databases, errors };
}

export interface ApplyTarget {
  workspaceProjectId: string;
  environmentId: string;
  ownerId: string | null;
  /** True for admin callers — quota checks are skipped exactly as elsewhere. */
  skipQuota: boolean;
}

export interface ApplyOutcome {
  id: string;
  status: 'succeeded' | 'partial' | 'failed';
  created_count: number;
  skipped_count: number;
  failed_count: number
  log: string;
  error: string | null;
}

/**
 * Create everything the spec declares. Records a `BlueprintApply` row first so a
 * crash mid-run still leaves the attempt visible, then finalizes it with the
 * per-item outcomes.
 */
export async function applyBlueprint(
  blueprint: { id: string; workspace_id: string; spec: string; spec_format: string },
  target: ApplyTarget,
): Promise<ApplyOutcome> {
  const parsed = parseSpec(blueprint.spec, blueprint.spec_format);
  const run = await prisma.blueprintApply.create({
    data: {
      blueprint_id: blueprint.id,
      workspace_project_id: target.workspaceProjectId,
      environment_id: target.environmentId,
      status: 'running',
    },
  });

  const lines: string[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  const finish = async (status: ApplyOutcome['status'], error: string | null) => {
    const log = lines.join('\n');
    await prisma.blueprintApply.update({
      where: { id: run.id },
      data: {
        status,
        created_count: created,
        skipped_count: skipped,
        failed_count: failed,
        log,
        error,
        finished_at: new Date(),
      },
    });
    return {
      id: run.id,
      status,
      created_count: created,
      skipped_count: skipped,
      failed_count: failed,
      log,
      error,
    };
  };

  if (parsed.errors.length) {
    lines.push(...parsed.errors.map((e) => `spec error: ${e}`));
    return finish('failed', 'The spec has errors, so nothing was created.');
  }

  // Existing names in the target environment. A blueprint is applied repeatedly
  // in practice, so an already-present resource is skipped, not duplicated.
  const existing = await prisma.project.findMany({
    where: { workspace_project_id: target.workspaceProjectId },
    select: { name: true },
  });
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));

  for (const service of parsed.services) {
    if (taken.has(service.name.toLowerCase())) {
      skipped += 1;
      lines.push(`skipped ${service.name}: a resource with that name already exists here.`);
      continue;
    }
    try {
      if (!target.skipQuota && target.ownerId) {
        await assertCanCreateApp(target.ownerId);
      }
    } catch (err) {
      failed += 1;
      lines.push(`failed ${service.name}: ${(err as { message?: string })?.message || 'quota check failed'}`);
      continue;
    }

    let projectId: string | null = null;
    try {
      const project = await prisma.project.create({
        data: {
          name: service.name,
          description: `Created by blueprint`,
          source_type: 'github',
          github_url: service.repo,
          github_branch: service.branch,
          project_type: 'app',
          domain: service.domain,
          status: 'pending',
          auto_deploy: service.autoDeploy,
          webhook_secret: crypto.randomBytes(32).toString('hex'),
          build_type: service.build,
          base_directory: service.rootDir,
          dockerfile_path: service.dockerfilePath,
          internal_port: service.port,
          // A private service or worker must never publish a host port; a web
          // service is reached through the proxy, so neither does it.
          publish_host_port: false,
          user_id: target.ownerId,
          workspace_project_id: target.workspaceProjectId,
          environment_id: target.environmentId,
        },
      });
      projectId = project.id;

      const projectPath = path.join(config.deploymentsPath, project.id);
      await cloneRepo(service.repo, projectPath, service.branch || undefined);

      for (const variable of service.envVars) {
        await prisma.envVariable.create({
          data: {
            project_id: project.id,
            service_name: '',
            key: variable.key,
            value: variable.value,
            is_runtime: true,
            is_build_arg: false,
            is_secret: false,
          },
        });
      }

      created += 1;
      taken.add(service.name.toLowerCase());
      lines.push(
        `created ${service.name} (${service.type}, ${service.repo}${service.branch ? `#${service.branch}` : ''}) — not deployed yet.`,
      );
    } catch (err) {
      failed += 1;
      lines.push(`failed ${service.name}: ${(err as Error)?.message || 'could not be created'}`);
      if (projectId) {
        // Roll the half-created resource back so a retry is clean.
        try {
          fs.rmSync(path.join(config.deploymentsPath, projectId), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
      }
    }
  }

  for (const database of parsed.databases) {
    if (taken.has(database.name.toLowerCase())) {
      skipped += 1;
      lines.push(`skipped ${database.name}: a resource with that name already exists here.`);
      continue;
    }
    try {
      if (!target.skipQuota && target.ownerId) {
        await assertCanCreateApp(target.ownerId);
      }
    } catch (err) {
      failed += 1;
      lines.push(`failed ${database.name}: ${(err as { message?: string })?.message || 'quota check failed'}`);
      continue;
    }

    const result = await provisionDatabase({
      name: database.name,
      engine: database.engine,
      version: database.version,
      ownerId: target.ownerId,
      workspaceProjectId: target.workspaceProjectId,
      environmentId: target.environmentId,
    });
    if (!result.ok) {
      failed += 1;
      lines.push(`failed ${database.name}: ${result.error}`);
      continue;
    }
    created += 1;
    taken.add(database.name.toLowerCase());
    lines.push(`created ${database.name} (${database.engine} ${result.tag}) — not started yet.`);
  }

  const status: ApplyOutcome['status'] =
    failed === 0 ? 'succeeded' : created === 0 ? 'failed' : 'partial';
  const error =
    failed === 0
      ? null
      : created === 0
        ? 'Nothing could be created — see the log for each reason.'
        : `${failed} of ${failed + created} items failed — see the log.`;
  return finish(status, error);
}

/**
 * Fetch a spec file out of a Git repository by cloning into a temp directory.
 * Returns the file text, or the reason it could not be read — never a guess.
 */
export async function fetchSpecFromRepo(
  repoUrl: string,
  branch: string | null,
  specPath: string,
): Promise<{ ok: true; spec: string } | { ok: false; error: string }> {
  if (!isHttpsGitUrl(repoUrl)) {
    return { ok: false, error: 'The repository must be an https Git URL.' };
  }
  const cleanPath = specPath.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..') || path.isAbsolute(cleanPath)) {
    return { ok: false, error: 'The spec path must be a relative path inside the repository.' };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-blueprint-'));
  try {
    await cloneRepo(repoUrl, tmp, branch || undefined);
    const full = path.join(tmp, cleanPath);
    // Resolve before reading so a symlinked spec path cannot escape the clone.
    const resolved = fs.realpathSync(full);
    if (!resolved.startsWith(fs.realpathSync(tmp) + path.sep)) {
      return { ok: false, error: 'The spec path resolves outside the repository.' };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: `${cleanPath} is not a file in that repository.` };
    }
    if (stat.size > 256 * 1024) {
      return { ok: false, error: `${cleanPath} is larger than 256 KiB.` };
    }
    return { ok: true, spec: fs.readFileSync(resolved, 'utf8') };
  } catch (err) {
    const message = (err as Error)?.message || 'the repository could not be read';
    if (/ENOENT|no such file/i.test(message)) {
      return { ok: false, error: `${cleanPath} was not found in that repository.` };
    }
    return { ok: false, error: message };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
