// Integrations + networking API: webhooks, observability streams, dedicated IPs
// and container-registry credentials.
//
// Plan gating is enforced here (not just in the UI): a Hobby workspace calling a
// PRO endpoint gets 403 PLAN_LOCKED with the required tier, which is what the
// <PlanGate/> card renders. Secrets are sealed with secretBox and are never
// returned by any response — only a boolean "configured" flag.

import express, { Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { AuthenticatedRequest } from '../lib/authMiddleware.js';
import { writeAudit } from '../lib/audit.js';
import { seal } from '../lib/secretBox.js';
import {
  FEATURE_TIERS,
  hasFeature,
  effectiveTier,
  requestedWorkspaceId,
  resolveWorkspace,
  sendWorkspaceError,
  tierLabel,
  assertWorkspaceWrite,
  type FeatureKey,
} from '../lib/workspace.js';

const router = express.Router();

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Resolve the workspace and refuse when its plan does not include `feature`. */
async function gated(req: AuthenticatedRequest, res: Response, feature: FeatureKey) {
  const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
  const tier = effectiveTier(workspace);
  if (!hasFeature(tier, feature)) {
    const required = FEATURE_TIERS[feature];
    res.status(403).json({
      success: false,
      error: {
        code: 'PLAN_LOCKED',
        message: `${tierLabel(required)} plan required.`,
        required_plan: required,
        current_plan: tier,
      },
    });
    return null;
  }
  return workspace;
}

/** Reject anything that is not an https URL we are willing to call. */
function validEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const WEBHOOK_EVENTS = [
  'deploy.started',
  'deploy.finished',
  'deploy.failed',
  'service.created',
  'service.deleted',
  'service.suspended',
  'service.health_changed',
] as const;

// ---------------------------------------------------------------- webhooks (PRO)

router.get('/webhooks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = effectiveTier(workspace);
    const unlocked = hasFeature(tier, 'webhooks');

    const hooks = unlocked
      ? await prisma.webhook.findMany({
          where: { workspace_id: workspace.id },
          orderBy: { created_at: 'desc' },
          include: {
            deliveries: { orderBy: { attempted_at: 'desc' }, take: 10 },
            _count: { select: { deliveries: true } },
          },
        })
      : [];

    res.json({
      plan: { key: tier, label: tierLabel(tier) },
      unlocked,
      required_plan: FEATURE_TIERS.webhooks,
      available_events: WEBHOOK_EVENTS,
      webhooks: hooks.map((hook) => ({
        id: hook.id,
        name: hook.name,
        url: hook.url,
        events: hook.events,
        enabled: hook.enabled,
        created_at: hook.created_at,
        delivery_count: hook._count.deliveries,
        // Secret is write-only: presence only, never the value.
        secret_configured: true,
        recent_deliveries: hook.deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          status_code: d.status_code,
          error: d.error,
          duration_ms: d.duration_ms,
          attempted_at: d.attempted_at,
        })),
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] webhooks failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load webhooks.');
  }
});

router.post('/webhooks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await gated(req, res, 'webhooks');
    if (!workspace) return;
    await assertWorkspaceWrite(req, workspace.id);

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) {
      return fail(res, 400, 'INVALID_NAME', 'Name must be 1–60 characters.');
    }
    const url = validEndpoint(req.body?.url);
    if (!url) return fail(res, 400, 'INVALID_URL', 'Endpoint must be an https:// URL.');

    const events: string[] = Array.isArray(req.body?.events) ? req.body.events : [];
    const unknown = events.filter((e) => !WEBHOOK_EVENTS.includes(e as never));
    if (events.length === 0) return fail(res, 400, 'NO_EVENTS', 'Select at least one event.');
    if (unknown.length) return fail(res, 400, 'INVALID_EVENT', `Unknown event: ${unknown[0]}`);

    // Caller-supplied secret is optional; otherwise generate a strong one.
    const providedSecret =
      typeof req.body?.secret === 'string' && req.body.secret.trim().length >= 16
        ? req.body.secret.trim()
        : crypto.randomBytes(32).toString('hex');

    const hook = await prisma.webhook.create({
      data: {
        workspace_id: workspace.id,
        name,
        url,
        secret_enc: seal(providedSecret),
        events,
      },
    });
    await writeAudit(req, 'webhook.create', `webhook:${hook.id}`, { name, url, events });

    // The signing secret is shown exactly once, at creation, so the receiver can
    // be configured. It is never retrievable afterwards.
    res.status(201).json({
      success: true,
      webhook: {
        id: hook.id,
        name: hook.name,
        url: hook.url,
        events: hook.events,
        enabled: hook.enabled,
        created_at: hook.created_at,
        delivery_count: 0,
        secret_configured: true,
        recent_deliveries: [],
      },
      secret_shown_once: providedSecret,
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] webhook create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not create the webhook.');
  }
});

router.patch('/webhooks/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const hook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
    if (!hook) return fail(res, 404, 'NOT_FOUND', 'Webhook not found.');
    const workspace = await resolveWorkspace(req, hook.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    const data: { enabled?: boolean; events?: string[]; url?: string; name?: string } = {};
    if (typeof req.body?.enabled === 'boolean') data.enabled = req.body.enabled;
    if (Array.isArray(req.body?.events)) {
      const unknown = req.body.events.filter((e: string) => !WEBHOOK_EVENTS.includes(e as never));
      if (unknown.length) return fail(res, 400, 'INVALID_EVENT', `Unknown event: ${unknown[0]}`);
      if (req.body.events.length === 0) return fail(res, 400, 'NO_EVENTS', 'Select at least one event.');
      data.events = req.body.events;
    }
    if (req.body?.url !== undefined) {
      const url = validEndpoint(req.body.url);
      if (!url) return fail(res, 400, 'INVALID_URL', 'Endpoint must be an https:// URL.');
      data.url = url;
    }
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (!name || name.length > 60) return fail(res, 400, 'INVALID_NAME', 'Name must be 1–60 characters.');
      data.name = name;
    }
    if (Object.keys(data).length === 0) return fail(res, 400, 'NO_CHANGES', 'Nothing to update.');

    const updated = await prisma.webhook.update({ where: { id: hook.id }, data });
    await writeAudit(req, 'webhook.update', `webhook:${hook.id}`, Object.keys(data));
    res.json({
      success: true,
      webhook: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
        events: updated.events,
        enabled: updated.enabled,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] webhook update failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not update the webhook.');
  }
});

router.delete('/webhooks/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const hook = await prisma.webhook.findUnique({ where: { id: req.params.id } });
    if (!hook) return fail(res, 404, 'NOT_FOUND', 'Webhook not found.');
    const workspace = await resolveWorkspace(req, hook.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    await prisma.webhook.delete({ where: { id: hook.id } });
    await writeAudit(req, 'webhook.delete', `webhook:${hook.id}`, { name: hook.name });
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] webhook delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the webhook.');
  }
});

// ------------------------------------------------------- observability streams

const STREAM_PROVIDERS = ['datadog', 'grafana', 'newrelic', 'honeycomb', 'otel', 'custom'] as const;

router.get('/observability', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const streams = await prisma.observabilityStream.findMany({
      where: { workspace_id: workspace.id },
    });
    const shape = (kind: 'metrics' | 'logs') => {
      const row = streams.find((s) => s.kind === kind);
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        provider: row.provider,
        endpoint: row.endpoint,
        enabled: row.enabled,
        include_preview: row.include_preview,
        // Never the key itself.
        secret_configured: !!row.secret_enc,
        last_test: row.last_test,
        last_test_at: row.last_test_at,
      };
    };
    res.json({
      providers: STREAM_PROVIDERS,
      metrics: shape('metrics'),
      logs: shape('logs'),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] observability failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load observability settings.');
  }
});

router.put('/observability/:kind', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const kind = req.params.kind;
    if (kind !== 'metrics' && kind !== 'logs') {
      return fail(res, 400, 'INVALID_KIND', 'Stream kind must be metrics or logs.');
    }
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const provider = String(req.body?.provider || 'custom').toLowerCase();
    if (!STREAM_PROVIDERS.includes(provider as never)) {
      return fail(res, 400, 'INVALID_PROVIDER', 'Unknown provider.');
    }
    const endpoint = validEndpoint(req.body?.endpoint);
    if (req.body?.endpoint && !endpoint) {
      return fail(res, 400, 'INVALID_URL', 'Destination must be an https:// URL.');
    }
    const enabled = req.body?.enabled === true;
    if (enabled && !endpoint) {
      return fail(res, 400, 'NO_ENDPOINT', 'Add a destination before enabling the stream.');
    }

    const secretUpdate =
      typeof req.body?.secret === 'string' && req.body.secret.trim()
        ? { secret_enc: seal(req.body.secret.trim()) }
        : {};

    const saved = await prisma.observabilityStream.upsert({
      where: { workspace_id_kind: { workspace_id: workspace.id, kind } },
      update: {
        provider,
        endpoint,
        enabled,
        include_preview: kind === 'logs' ? req.body?.include_preview === true : false,
        ...secretUpdate,
      },
      create: {
        workspace_id: workspace.id,
        kind,
        provider,
        endpoint,
        enabled,
        include_preview: kind === 'logs' ? req.body?.include_preview === true : false,
        ...secretUpdate,
      },
    });
    await writeAudit(req, `observability.${kind}.update`, `workspace:${workspace.id}`, {
      provider,
      enabled,
    });
    res.json({
      success: true,
      stream: {
        id: saved.id,
        kind: saved.kind,
        provider: saved.provider,
        endpoint: saved.endpoint,
        enabled: saved.enabled,
        include_preview: saved.include_preview,
        secret_configured: !!saved.secret_enc,
        last_test: saved.last_test,
        last_test_at: saved.last_test_at,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] observability save failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the stream.');
  }
});

// POST /api/integrations/observability/:kind/test — real reachability probe.
router.post('/observability/:kind/test', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const kind = req.params.kind;
    if (kind !== 'metrics' && kind !== 'logs') {
      return fail(res, 400, 'INVALID_KIND', 'Stream kind must be metrics or logs.');
    }
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const stream = await prisma.observabilityStream.findUnique({
      where: { workspace_id_kind: { workspace_id: workspace.id, kind } },
    });
    if (!stream?.endpoint) {
      return fail(res, 409, 'NO_ENDPOINT', 'Configure a destination first.');
    }

    const started = Date.now();
    let ok = false;
    let detail = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const probe = await fetch(stream.endpoint, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);
      ok = probe.status < 500;
      detail = `HTTP ${probe.status}`;
    } catch (probeErr) {
      detail = probeErr instanceof Error ? probeErr.message : 'Request failed';
    }

    await prisma.observabilityStream.update({
      where: { id: stream.id },
      data: { last_test: ok ? 'ok' : 'failed', last_test_at: new Date() },
    });
    await writeAudit(req, `observability.${kind}.test`, `workspace:${workspace.id}`, { ok });
    res.json({ success: true, ok, detail, duration_ms: Date.now() - started });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] observability test failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not test the connection.');
  }
});

// ----------------------------------------------------------- dedicated IPs (PRO)

router.get('/dedicated-ips', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const tier = effectiveTier(workspace);
    const unlocked = hasFeature(tier, 'dedicated_ips');
    const ips = unlocked
      ? await prisma.dedicatedIp.findMany({
          where: { workspace_id: workspace.id },
          orderBy: { created_at: 'desc' },
        })
      : [];
    res.json({
      plan: { key: tier, label: tierLabel(tier) },
      unlocked,
      required_plan: FEATURE_TIERS.dedicated_ips,
      ips: ips.map((ip) => ({
        id: ip.id,
        address: ip.address,
        region: ip.region,
        status: ip.status,
        created_at: ip.created_at,
        // Assignment lands with the private-networking phase; report honestly.
        assigned_services: [] as string[],
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] dedicated ips failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load dedicated IPs.');
  }
});

// ------------------------------------------------- registry credentials (all plans)

const REGISTRY_PROVIDERS = ['dockerhub', 'ghcr', 'gitlab', 'custom'] as const;

router.get('/registry-credentials', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    const creds = await prisma.registryCredential.findMany({
      where: { workspace_id: workspace.id },
      orderBy: { created_at: 'desc' },
    });
    res.json({
      providers: REGISTRY_PROVIDERS,
      credentials: creds.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        registry_host: c.registry_host,
        username: c.username,
        // Sealed secret is never returned, not even masked characters of it.
        secret_configured: true,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] registry list failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not load registry credentials.');
  }
});

router.post('/registry-credentials', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const workspace = await resolveWorkspace(req, requestedWorkspaceId(req));
    await assertWorkspaceWrite(req, workspace.id);

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const provider = String(req.body?.provider || '').toLowerCase();
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
    const host = typeof req.body?.registry_host === 'string' ? req.body.registry_host.trim() : '';

    if (!name || name.length > 60) return fail(res, 400, 'INVALID_NAME', 'Name must be 1–60 characters.');
    if (!REGISTRY_PROVIDERS.includes(provider as never)) {
      return fail(res, 400, 'INVALID_PROVIDER', 'Unknown registry provider.');
    }
    if (!username) return fail(res, 400, 'INVALID_USERNAME', 'Username is required.');
    if (!secret) return fail(res, 400, 'INVALID_SECRET', 'Password or token is required.');
    if (provider === 'custom' && !host) {
      return fail(res, 400, 'INVALID_HOST', 'Custom registries need a host.');
    }

    const cred = await prisma.registryCredential.create({
      data: {
        workspace_id: workspace.id,
        name,
        provider,
        registry_host: host || null,
        username,
        secret_enc: seal(secret),
      },
    });
    await writeAudit(req, 'registry.credential.create', `registry_credential:${cred.id}`, {
      provider,
      name,
    });
    res.status(201).json({
      success: true,
      credential: {
        id: cred.id,
        name: cred.name,
        provider: cred.provider,
        registry_host: cred.registry_host,
        username: cred.username,
        secret_configured: true,
        created_at: cred.created_at,
      },
    });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] registry create failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not save the credential.');
  }
});

router.delete('/registry-credentials/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cred = await prisma.registryCredential.findUnique({ where: { id: req.params.id } });
    if (!cred) return fail(res, 404, 'NOT_FOUND', 'Credential not found.');
    const workspace = await resolveWorkspace(req, cred.workspace_id);
    await assertWorkspaceWrite(req, workspace.id);

    await prisma.registryCredential.delete({ where: { id: cred.id } });
    await writeAudit(req, 'registry.credential.delete', `registry_credential:${cred.id}`);
    res.json({ success: true });
  } catch (err) {
    if (sendWorkspaceError(res, err)) return;
    console.error('[integrations] registry delete failed:', err);
    fail(res, 500, 'INTERNAL', 'Could not delete the credential.');
  }
});

export default router;
