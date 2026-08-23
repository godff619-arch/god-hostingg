/**
 * Managed-database provisioning, shared by the databases API and blueprint
 * applies. Extracted from `routes/databases.ts` so both callers create a
 * database exactly the same way — one code path, one set of rollback rules.
 *
 * Nothing here is optimistic: the Docker volume must actually be created before
 * the rows are kept, and a failure rolls the project row back and returns the
 * engine's own error text rather than a generic message.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import prisma from './prisma.js';
import { config } from './config.js';
import {
  composeProjectName,
  dockerSlug,
  serviceContainerName,
  shortPathHash,
  shortProjectId,
} from './naming.js';
import {
  defaultDatabaseCredentials,
  engineRuntimeEnv,
  getDatabaseEngine,
  isDatabaseEngineId,
  listDatabaseEngines,
  listDatabaseEnginesWithLiveVersions,
  managedServiceMarker,
  resolveEngineImage,
  volumeMountForEngine,
} from './databaseEngines.js';
import { connectionUrlFor } from './databaseLinks.js';

export interface ProvisionDatabaseInput {
  name: string;
  engine: unknown;
  /** Image tag / version, as the caller wrote it. NULL takes the recommended tag. */
  version?: string | null;
  /** Owner of the resource. NULL for internal/admin calls, matching the API. */
  ownerId: string | null;
  /** Explicit placement. Blueprint applies always set both; the API leaves them null. */
  workspaceProjectId?: string | null;
  environmentId?: string | null;
}

export type ProvisionDatabaseResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      project: Awaited<ReturnType<typeof prisma.project.create>>;
      service: Awaited<ReturnType<typeof prisma.service.create>>;
      volume: Awaited<ReturnType<typeof prisma.persistentVolume.create>>;
      engine: ReturnType<typeof getDatabaseEngine> & object;
      image: string;
      tag: string;
      connection_url: string;
      credentials: { username: string | null; database: string; password: string };
    };

/**
 * Create a managed database resource. Returns a typed failure instead of
 * throwing so a blueprint apply can record the reason against one item and
 * carry on with the rest of the spec.
 */
export async function provisionDatabase(
  input: ProvisionDatabaseInput,
): Promise<ProvisionDatabaseResult> {
  const nameTrim = typeof input.name === 'string' ? input.name.trim() : '';
  if (!nameTrim || nameTrim.length > 120) {
    return { ok: false, status: 400, error: 'Name is required (max 120 characters)' };
  }
  const engineId = input.engine;
  if (!isDatabaseEngineId(engineId)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid engine. Use one of: ${listDatabaseEngines().map((e) => e.id).join(', ')}`,
    };
  }
  const engine = getDatabaseEngine(engineId)!;
  const liveCatalog = await listDatabaseEnginesWithLiveVersions();
  const liveEngine = liveCatalog.find((e) => e.id === engineId) || engine;
  const resolved = resolveEngineImage(liveEngine, input.version ?? null, {
    allowedTags: liveEngine.versions.map((v) => v.tag),
  });
  if ('error' in resolved) {
    return { ok: false, status: 400, error: resolved.error };
  }
  const { image: selectedImage, tag: selectedTag } = resolved;

  const creds = defaultDatabaseCredentials(nameTrim);
  const runtimeEnv = engineRuntimeEnv(engine, creds);

  const project = await prisma.project.create({
    data: {
      name: nameTrim,
      description: `${engine.label} ${selectedTag} managed by DockLift`,
      source_type: 'managed',
      project_type: 'database',
      db_engine: engine.id,
      status: 'pending',
      auto_deploy: false,
      build_type: 'dockerfile',
      base_directory: '.',
      dockerfile_path: null,
      internal_port: engine.port,
      publish_host_port: false,
      user_id: input.ownerId,
      workspace_project_id: input.workspaceProjectId ?? null,
      environment_id: input.environmentId ?? null,
    },
  });

  const projectPath = path.join(config.deploymentsPath, project.id);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'README.docklift-db.md'),
    `# ${nameTrim}\n\nManaged ${engine.label} (${selectedImage}).\nDo not replace with application source.\n`,
    'utf8',
  );

  const containerName = serviceContainerName(project.name, project.id, engine.serviceName);
  const service = await prisma.service.create({
    data: {
      project_id: project.id,
      name: engine.serviceName,
      dockerfile_path: managedServiceMarker(engine.id, selectedImage),
      container_name: containerName,
      internal_port: engine.port,
      port: null,
      status: 'pending',
    },
  });

  for (const [key, value] of Object.entries(runtimeEnv)) {
    await prisma.envVariable.create({
      data: {
        project_id: project.id,
        service_name: '',
        key,
        value,
        is_runtime: true,
        is_build_arg: false,
        is_secret: key.toLowerCase().includes('password'),
      },
    });
  }

  const volumeLabel = 'data';
  const volumeName = `dl-${shortProjectId(project.id)}-${dockerSlug(volumeLabel, 28)}-${shortPathHash(volumeLabel)}`;
  const volume = await prisma.persistentVolume.create({
    data: {
      project_id: project.id,
      service_name: engine.serviceName,
      name: volumeName,
      display_name: volumeLabel,
      mount_path: volumeMountForEngine(engine, selectedImage),
    },
  });
  const volResult = spawnSync(
    'docker',
    [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${composeProjectName(project.name, project.id)}`,
      '--label',
      `com.docklift.project=${project.id}`,
      '--label',
      'com.docklift.role=managed-database',
      volumeName,
    ],
    { encoding: 'utf8', shell: false, timeout: 30000 },
  );
  if (volResult.status !== 0) {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    try {
      fs.rmSync(projectPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: 500,
      error:
        volResult.stderr?.trim() ||
        volResult.error?.message ||
        'Failed to create Docker volume for database',
    };
  }

  return {
    ok: true,
    project,
    service,
    volume,
    engine,
    image: selectedImage,
    tag: selectedTag,
    connection_url: connectionUrlFor(engine, containerName, creds),
    credentials: {
      username: creds.username || null,
      database: creds.database,
      // Returned once at create so the operator can copy it; never re-read later.
      password: creds.password,
    },
  };
}
