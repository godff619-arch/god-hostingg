/**
 * Managed databases API — Coolify/Dokploy-style engine catalog + Dokku-style links.
 */
import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { serviceContainerName } from '../lib/naming.js';
import {
  getDatabaseEngine,
  listDatabaseEngines,
  listDatabaseEnginesWithLiveVersions,
} from '../lib/databaseEngines.js';
import {
  assertEnvKeyAvailable,
  connectionUrlFor,
  ensureDbOnAppNetwork,
  loadDatabaseCredentials,
  unlinkDatabaseLink,
  upsertLinkedEnv,
} from '../lib/databaseLinks.js';
import {
  type AuthenticatedRequest,
  assertProjectAccess,
  sendAccessError,
  isAdmin,
} from '../lib/authMiddleware.js';
import { assertCanCreateApp } from '../lib/quota.js';
import { provisionDatabase } from '../lib/databaseProvision.js';
import { resolveResourcePlacement, sendPlacementError } from '../lib/resourcePlacement.js';

const router = Router();

router.get('/engines', async (_req: Request, res: Response) => {
  try {
    // Live tags from Docker Hub (cached); static list if Hub is down
    const engines = await listDatabaseEnginesWithLiveVersions();
    res.json(engines);
  } catch (error) {
    console.error(error);
    res.json(listDatabaseEngines());
  }
});

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      where: {
        project_type: 'database',
        ...(isAdmin(req) ? {} : { user_id: req.user?.userId }),
      },
      include: {
        services: true,
        databaseLinksAsDb: {
          include: {
            app_project: { select: { id: true, name: true, status: true } },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    res.json(projects);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to list databases' });
  }
});

/** Links targeting an app project (for Project detail UI). Must be before /:id. */
router.get('/links/by-app/:appProjectId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await assertProjectAccess(req, req.params.appProjectId);
    const links = await prisma.databaseLink.findMany({
      where: { app_project_id: req.params.appProjectId },
      include: {
        database_project: {
          select: {
            id: true,
            name: true,
            status: true,
            db_engine: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    res.json(links);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to list app database links' });
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId =
      req.user?.userId && req.user.userId !== 'internal' ? req.user.userId : null;
    if (ownerId && !isAdmin(req)) {
      await assertCanCreateApp(ownerId);
    }
    const versionRaw =
      typeof req.body?.version === 'string'
        ? req.body.version
        : typeof req.body?.tag === 'string'
          ? req.body.tag
          : typeof req.body?.image === 'string'
            ? req.body.image
            : null;

    // Same hierarchy contract as POST /api/projects: created inside the project +
    // environment the caller is looking at, when they send one.
    let placement;
    try {
      placement = await resolveResourcePlacement(
        req,
        req.body?.workspace_project_id,
        req.body?.environment_id,
      );
    } catch (err) {
      if (sendPlacementError(res, err)) return;
      throw err;
    }

    // Shared with blueprint applies — one provisioning path, one rollback rule.
    const result = await provisionDatabase({
      name: req.body?.name,
      engine: req.body?.engine,
      version: versionRaw,
      ownerId,
      workspaceProjectId: placement.workspace_project_id,
      environmentId: placement.environment_id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(201).json({
      ...result.project,
      services: [result.service],
      persistent_volumes: [result.volume],
      engine: { ...result.engine, image: result.image },
      image: result.image,
      version: result.tag,
      connection_url: result.connection_url,
      credentials: result.credentials,
    });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to create database' });
  }
});

router.get('/:id/connection', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await assertProjectAccess(req, req.params.id);
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, project_type: 'database' },
      include: { services: { take: 1 } },
    });
    const loaded = await loadDatabaseCredentials(req.params.id);
    if (!loaded || !project) {
      return res.status(404).json({ error: 'Managed database not found or credentials missing' });
    }
    const { engine, creds, host } = loaded;
    const publishHost = project.publish_host_port === true;
    const hostPort = project.services[0]?.port;
    const exposed = publishHost && typeof hostPort === 'number' && hostPort > 0;
    res.json({
      engine,
      host,
      port: engine.port,
      username: creds.username || null,
      database: creds.database,
      password: creds.password,
      connection_url: connectionUrlFor(engine, host, creds),
      internal_only: !exposed,
      publish_host_port: publishHost,
      host_port: exposed ? hostPort : null,
      // Product treats credentials as recreate-to-rotate (env edits blocked).
      credentials_init_only: true,
      note: exposed
        ? `Host port ${hostPort} is published — this database may be reachable on the server IP. Prefer linking apps over sharing IP:port.`
        : 'Reachable from linked apps on the app Docker network via the host above. Prefer linking over publishing host ports.',
    });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to load connection info' });
  }
});

router.get('/:id/links', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await assertProjectAccess(req, req.params.id);
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, project_type: 'database' },
    });
    if (!project) return res.status(404).json({ error: 'Database not found' });
    const links = await prisma.databaseLink.findMany({
      where: { database_project_id: project.id },
      include: {
        app_project: {
          select: {
            id: true,
            name: true,
            status: true,
            services: { select: { id: true, name: true, status: true } },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    res.json(links);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to list links' });
  }
});

router.post('/:id/links', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await assertProjectAccess(req, req.params.id);
    const dbProject = await prisma.project.findFirst({
      where: { id: req.params.id, project_type: 'database' },
    });
    if (!dbProject || !dbProject.db_engine) {
      return res.status(404).json({ error: 'Database not found' });
    }
    const engine = getDatabaseEngine(dbProject.db_engine);
    if (!engine) return res.status(400).json({ error: 'Unknown database engine' });

    const appProjectId = typeof req.body?.app_project_id === 'string' ? req.body.app_project_id.trim() : '';
    if (!appProjectId) {
      return res.status(400).json({ error: 'app_project_id is required' });
    }
    const app = await prisma.project.findFirst({
      where: { id: appProjectId, project_type: { not: 'database' } },
      include: { services: true },
    });
    if (!app) {
      return res.status(404).json({ error: 'App project not found' });
    }
    // Linking exposes DB credentials into the app's env — require access to both sides.
    await assertProjectAccess(req, app.id);

    let serviceName =
      typeof req.body?.service_name === 'string' ? req.body.service_name.trim() : '';
    if (serviceName) {
      const ok = app.services.some((s) => s.name === serviceName);
      if (!ok) {
        return res.status(400).json({ error: `Service "${serviceName}" not found on that project` });
      }
    } else {
      serviceName = '';
    }

    const envKey =
      typeof req.body?.env_key === 'string' && req.body.env_key.trim()
        ? req.body.env_key.trim()
        : engine.defaultEnvKey;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey) || envKey.length > 64) {
      return res.status(400).json({ error: 'Invalid env_key' });
    }

    const loaded = await loadDatabaseCredentials(dbProject.id);
    if (!loaded) {
      return res.status(400).json({
        error: 'Database credentials missing — deploy the database first',
      });
    }

    if (dbProject.status !== 'running' && dbProject.status !== 'degraded') {
      return res.status(409).json({
        error: 'Database must be running before linking. Deploy it first.',
      });
    }

    const overwrite = req.body?.overwrite === true;
    try {
      await assertEnvKeyAvailable({
        appProjectId: app.id,
        serviceName,
        envKey,
        databaseProjectId: dbProject.id,
        overwrite,
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 400;
      return res.status(status).json({
        error: err instanceof Error ? err.message : 'Env key conflict',
      });
    }

    const url = connectionUrlFor(loaded.engine, loaded.host, loaded.creds);

    // Link row first (ownership), then env — avoids orphan env if create fails mid-way.
    const link = await prisma.databaseLink.upsert({
      where: {
        database_project_id_app_project_id_service_name_env_key: {
          database_project_id: dbProject.id,
          app_project_id: app.id,
          service_name: serviceName,
          env_key: envKey,
        },
      },
      create: {
        database_project_id: dbProject.id,
        app_project_id: app.id,
        service_name: serviceName,
        env_key: envKey,
      },
      update: {},
    });

    await upsertLinkedEnv({
      appProjectId: app.id,
      serviceName,
      envKey,
      value: url,
    });

    let networkAttached = true;
    let networkError: string | null = null;
    try {
      await ensureDbOnAppNetwork(dbProject.id, app.id);
    } catch (err) {
      networkAttached = false;
      networkError =
        err instanceof Error
          ? err.message
          : 'Could not attach database to the app network yet';
    }

    res.status(201).json({
      link,
      env_key: envKey,
      service_name: serviceName || null,
      network_attached: networkAttached,
      network_error: networkError,
      note: networkAttached
        ? 'Connection URL injected as a runtime secret. Redeploy the app for containers to pick up the new env.'
        : `Connection URL saved. Network attach pending (${networkError}). Redeploy the app (and ensure the database is running) to join networks.`,
    });
  } catch (error: unknown) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    const code = (error as { code?: string })?.code;
    if (code === 'P2002') {
      return res.status(409).json({ error: 'This link already exists' });
    }
    res.status(500).json({ error: 'Failed to link database' });
  }
});

router.delete('/:id/links/:linkId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await assertProjectAccess(req, req.params.id);
    const link = await prisma.databaseLink.findFirst({
      where: {
        id: req.params.linkId,
        database_project_id: req.params.id,
      },
    });
    if (!link) return res.status(404).json({ error: 'Link not found' });

    await unlinkDatabaseLink(link.id);

    res.json({
      status: 'unlinked',
      note: 'Env removed if no other database owns that key. Redeploy the app to drop it from running containers.',
    });
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to unlink database' });
  }
});

export default router;
