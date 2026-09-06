// Ports routes - API endpoints for port allocation management
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { config } from '../lib/config.js';
import * as dockerService from '../services/docker.js';
import { detectPortFromContent } from '../services/compose.js';

const router = Router();

// List all ports (+ projects running without a host port — private by default)
router.get('/', async (req: Request, res: Response) => {
  try {
    const dbPorts = await prisma.port.findMany({
      include: {
        project: {
          select: { id: true, name: true, status: true },
        },
      },
    });

    const portMap = new Map(dbPorts.map((p) => [p.port, p]));

    const ports = [];
    for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
      if (portMap.has(p)) {
        ports.push(portMap.get(p));
      } else {
        ports.push({
          port: p,
          project_id: null,
          is_locked: false,
        });
      }
    }

    // Projects can be Running with zero host ports (domains / Docker DNS / DB linking)
    const allocatedProjectIds = new Set(
      dbPorts
        .filter((p) => p.is_locked && p.project_id)
        .map((p) => p.project_id as string),
    );

    const live = await prisma.project.findMany({
      where: {
        status: { in: ['running', 'degraded', 'building', 'pending'] },
      },
      select: {
        id: true,
        name: true,
        status: true,
        project_type: true,
        db_engine: true,
        publish_host_port: true,
        services: {
          select: { id: true, port: true, name: true },
        },
      },
      orderBy: { updated_at: 'desc' },
    });

    const private_running = live
      .filter((project) => {
        if (allocatedProjectIds.has(project.id)) return false;
        const hasHostPort = project.services.some(
          (s) => typeof s.port === 'number' && s.port > 0,
        );
        return !hasHostPort;
      })
      .map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        project_type: project.project_type,
        db_engine: project.db_engine,
        publish_host_port: project.publish_host_port === true,
        reason:
          project.project_type === 'database'
            ? 'Managed databases stay off the host — link them to apps over Docker DNS'
            : project.publish_host_port
              ? 'Publish host ports is on — redeploy to claim a pool port'
              : 'Private by default — add a domain or enable Publish host ports + redeploy',
      }));

    res.json({
      ports,
      private_running,
      pool: {
        start: config.portRangeStart,
        end: config.portRangeEnd,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to list ports' });
  }
});

// Next available host port in the pool
router.get('/next-available', async (req: Request, res: Response) => {
  try {
    const locked = await prisma.port.findMany({
      where: { is_locked: true },
      select: { port: true },
    });
    const usedSet = new Set(locked.map((p) => p.port));
    const total = config.portRangeEnd - config.portRangeStart + 1;

    let nextAvailable: number | null = null;
    for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
      if (!usedSet.has(p)) {
        nextAvailable = p;
        break;
      }
    }

    res.json({
      next_available: nextAvailable,
      pool: { start: config.portRangeStart, end: config.portRangeEnd },
      used_count: usedSet.size,
      total,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to check port availability' });
  }
});

// Detect suggested internal port from a GitHub repo
router.post('/detect', async (req: Request, res: Response) => {
  try {
    const { github_url, github_branch } = req.body;
    if (!github_url || typeof github_url !== 'string') {
      return res.status(400).json({ error: 'github_url is required' });
    }

    const branch = github_branch || 'main';
    const match = github_url.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (!match) {
      return res.json({ suggested_internal_port: 3000, reason: 'Could not parse GitHub URL — using default' });
    }

    const [, owner, repo] = match;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'GodHosting',
    };

    const tryFetch = async (filePath: string): Promise<string | null> => {
      try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
        const r = await fetch(url, { headers });
        if (r.ok) return await r.text();
      } catch { /* network error */ }
      return null;
    };

    const dockerfile = await tryFetch('Dockerfile');
    if (dockerfile) {
      const result = detectPortFromContent(dockerfile);
      return res.json({ suggested_internal_port: result.port, reason: result.reason });
    }

    const packageJson = await tryFetch('package.json');
    if (packageJson) {
      const lower = packageJson.toLowerCase();
      if (lower.includes('"next"')) return res.json({ suggested_internal_port: 3000, reason: 'Detected Next.js in package.json' });
      if (lower.includes('"vite"') || lower.includes('"@vitejs')) return res.json({ suggested_internal_port: 5173, reason: 'Detected Vite in package.json' });
      if (lower.includes('"express"')) return res.json({ suggested_internal_port: 3000, reason: 'Detected Express in package.json' });
      if (lower.includes('"fastify"')) return res.json({ suggested_internal_port: 3000, reason: 'Detected Fastify in package.json' });
      if (lower.includes('"nuxt"')) return res.json({ suggested_internal_port: 3000, reason: 'Detected Nuxt in package.json' });
      return res.json({ suggested_internal_port: 3000, reason: 'Node.js project detected — using default port' });
    }

    const requirements = await tryFetch('requirements.txt');
    if (requirements) {
      const lower = requirements.toLowerCase();
      if (lower.includes('fastapi') || lower.includes('uvicorn')) return res.json({ suggested_internal_port: 8000, reason: 'Detected FastAPI in requirements.txt' });
      if (lower.includes('flask')) return res.json({ suggested_internal_port: 5000, reason: 'Detected Flask in requirements.txt' });
      if (lower.includes('django')) return res.json({ suggested_internal_port: 8000, reason: 'Detected Django in requirements.txt' });
      return res.json({ suggested_internal_port: 8000, reason: 'Python project detected — using default port' });
    }

    const goMod = await tryFetch('go.mod');
    if (goMod) return res.json({ suggested_internal_port: 8080, reason: 'Go project detected' });

    const gemfile = await tryFetch('Gemfile');
    if (gemfile) {
      const lower = gemfile.toLowerCase();
      if (lower.includes('rails')) return res.json({ suggested_internal_port: 3000, reason: 'Detected Rails in Gemfile' });
      return res.json({ suggested_internal_port: 3000, reason: 'Ruby project detected' });
    }

    res.json({ suggested_internal_port: 3000, reason: 'Default port' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Port detection failed' });
  }
});

// Delete port allocation
router.delete('/:port', async (req: Request, res: Response) => {
  try {
    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port)) {
      return res.status(400).json({ error: 'Invalid port' });
    }

    const servicesOnPort = await prisma.service.findMany({
      where: { port },
      select: { container_name: true },
    });
    const projectRef = await prisma.project.findFirst({ where: { port } });

    for (const svc of servicesOnPort) {
      if (!svc.container_name) continue;
      try {
        const status = await dockerService.getContainerStatus(svc.container_name);
        if (status.running) {
          return res.status(409).json({ error: 'Port is in use by a running container' });
        }
      } catch {
        // ignore inspect errors
      }
    }

    if (servicesOnPort.length > 0 || projectRef) {
      return res.status(409).json({
        error: 'Port is still assigned to a service or project',
      });
    }

    await prisma.port.deleteMany({
      where: { port },
    });

    res.json({ status: 'deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete port' });
  }
});

export default router;
