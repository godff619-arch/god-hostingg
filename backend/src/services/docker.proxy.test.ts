import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_PROXY_CONTAINER, isEdgeProxyMissingError, isProxyAlreadyConnectedError } from './docker.js';
import { shouldReconnectProxyAfterFailedTeardown } from '../lib/composeTeardown.js';

test('isEdgeProxyMissingError only matches an absent edge proxy container', () => {
  const notFound = Object.assign(
    new Error(
      `(HTTP code 404) network or container is not found - No such container: ${EDGE_PROXY_CONTAINER}`,
    ),
    { statusCode: 404 },
  );
  assert.equal(isEdgeProxyMissingError(notFound), true);

  // A missing project network is a real failure, not a missing proxy.
  assert.equal(
    isEdgeProxyMissingError(
      Object.assign(new Error('(HTTP code 404) no such network - network dl-net-abc not found'), {
        statusCode: 404,
      }),
    ),
    false,
  );
  assert.equal(isEdgeProxyMissingError(new Error('permission denied')), false);
  assert.equal(isEdgeProxyMissingError(undefined), false);
});

test('isProxyAlreadyConnectedError recognizes docker duplicate endpoint errors', () => {
  assert.equal(
    isProxyAlreadyConnectedError(new Error('endpoint with name x already exists in network y')),
    true
  );
  assert.equal(isProxyAlreadyConnectedError('container already connected'), true);
  assert.equal(isProxyAlreadyConnectedError(new Error('network not found')), false);
});

test('failed teardown requires proxy reconnect; success does not', () => {
  assert.equal(shouldReconnectProxyAfterFailedTeardown(false), true);
  assert.equal(shouldReconnectProxyAfterFailedTeardown(true), false);
});

test('connectProxyToProjectNetwork surfaces non-duplicate failures', async () => {
  const mod = await import('./docker.js');
  assert.equal(typeof mod.connectProxyToProjectNetwork, 'function');
  assert.equal(typeof mod.disconnectProxyFromProjectNetwork, 'function');

  // Missing project network → must reject (never silent success)
  await assert.rejects(
    () => mod.connectProxyToProjectNetwork('00000000-0000-0000-0000-000000000099'),
    (err: unknown) => err instanceof Error || typeof err === 'object'
  );
});

test('edgeProxyExists answers a boolean instead of throwing when Docker is absent', async () => {
  const mod = await import('./docker.js');
  const first = await mod.edgeProxyExists();
  assert.equal(typeof first, 'boolean');
  // Memoized within the TTL, so a deploy pays one inspect at most
  assert.equal(await mod.edgeProxyExists(), first);
  mod.invalidateEdgeProxyProbe();
  assert.equal(typeof (await mod.edgeProxyExists()), 'boolean');
});
