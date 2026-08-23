// Container logs routes - real-time log streaming for project containers
import { Router, Response } from 'express';
import prisma from '../lib/prisma.js';
import { getContainerStatus } from '../services/docker.js';
import { streamContainerLogs } from '../services/docker.js';
import {
  type AuthenticatedRequest,
  assertProjectAccess,
  sendAccessError,
} from '../lib/authMiddleware.js';

const router = Router();

// Get list of containers for a project
router.get('/:projectId/containers', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    await assertProjectAccess(req, projectId);

    const services = await prisma.service.findMany({
      where: { project_id: projectId },
    });

    // Enrich with live status
    const containers = await Promise.all(
      services.map(async (svc) => {
        const status = svc.container_name
          ? await getContainerStatus(svc.container_name)
          : { status: 'unknown', running: false };

        return {
          id: svc.id,
          name: svc.name,
          container_name: svc.container_name,
          port: svc.port,
          internal_port: svc.internal_port,
          dockerfile_path: svc.dockerfile_path,
          status: status.status,
          running: status.running,
        };
      })
    );

    res.json(containers);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error('Failed to list containers:', error);
    res.status(500).json({ error: 'Failed to list containers' });
  }
});

// Stream real-time logs for a specific container (SSE)
router.get('/:projectId/stream/:containerName', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId, containerName } = req.params;
    const tail = parseInt(req.query.tail as string) || 200;
    await assertProjectAccess(req, projectId);

    // Verify the container belongs to this project
    const service = await prisma.service.findFirst({
      where: {
        project_id: projectId,
        container_name: containerName,
      },
    });

    if (!service) {
      return res.status(404).json({ error: 'Container not found for this project' });
    }

    // Start streaming
    streamContainerLogs(containerName, res, tail);
  } catch (error) {
    if (sendAccessError(res, error)) return;
    console.error('Failed to stream container logs:', error);
    res.status(500).json({ error: 'Failed to stream logs' });
  }
});

export default router;
