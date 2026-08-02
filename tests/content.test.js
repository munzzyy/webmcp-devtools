// tests/content.test.js
//
// Drives the real content.js (isolated-world relay) through the worldHarness
// fakes. Pins the trust checks: only same-window, nonce-carrying, allowlisted
// bridge messages reach the Port; panel commands go out with the nonce; and a
// dropped Port (MV3 service-worker cycle) reconnects instead of going silent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from './worldHarness.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('content.js leaves the handshake nonce on the document element', () => {
  const c = loadContent();
  assert.ok(typeof c.nonce === 'string' && c.nonce.length > 0);
});

test('a valid bridge message is forwarded to the port without its envelope', () => {
  const c = loadContent();
  c.postAsBridge({ type: 'tools', origin: 'https://page.example', hasModelContext: true, tools: [] }, { nonce: c.nonce });
  const sent = c.port().sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'tools');
  assert.equal(sent[0].webmcpDevtools, undefined);
  assert.equal(sent[0].nonce, undefined);
});

test('a status message is marked as coming from a live bridge', () => {
  const c = loadContent();
  c.postAsBridge({ type: 'status', origin: 'https://page.example', hasModelContext: true }, { nonce: c.nonce });
  assert.equal(c.port().sent[0].bridge, true);
});

test('messages with a wrong nonce, wrong source, or unknown type are dropped', () => {
  const c = loadContent();
  c.postAsBridge({ type: 'tools', tools: [] }, { nonce: 'forged' });
  c.postAsBridge({ type: 'tools', tools: [] }, { nonce: c.nonce, source: { fake: 'iframe window' } });
  c.postAsBridge({ type: 'evilNewType', payload: 'x' }, { nonce: c.nonce });
  assert.equal(c.port().sent.length, 0);
});

test('panel commands are relayed to the bridge carrying the nonce', () => {
  const c = loadContent();
  c.port().emit({ type: 'getTools' });
  c.port().emit({ type: 'executeTool', callId: 'c1', toolId: 't1', toolName: 'x', argsJson: '{}' });
  c.port().emit({ type: 'somethingElse' }); // not a panel command; must not cross
  const commands = c.posted.filter((m) => m.webmcpDevtools === 'content');
  assert.equal(commands.length, 2);
  assert.ok(commands.every((m) => m.nonce === c.nonce));
  assert.deepEqual(commands.map((m) => m.type), ['getTools', 'executeTool']);
});

test('a disconnected port reconnects and refreshes through the bridge', async () => {
  const c = loadContent();
  assert.equal(c.connects.length, 1);
  c.port().disconnect();
  await wait(400); // first backoff step is 250ms
  assert.equal(c.connects.length, 2, 'expected a reconnect after the port dropped');
  const refresh = c.posted.filter((m) => m.webmcpDevtools === 'content' && m.type === 'getTools');
  assert.ok(refresh.length >= 1, 'expected a getTools refresh after reconnecting');
});

test('with no bridge check-in, a loud bridge:false status is reported', async () => {
  const c = loadContent();
  await wait(2300); // BRIDGE_TIMEOUT_MS is 2000
  const statuses = c.port().sent.filter((m) => m.type === 'status');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].bridge, false);
  assert.equal(statuses[0].hasModelContext, false);
});

test('after bridge-ready, no synthetic failure status is emitted', async () => {
  const c = loadContent();
  c.postAsBridge({ type: 'bridge-ready' }, { nonce: c.nonce });
  await wait(2300);
  const statuses = c.port().sent.filter((m) => m.type === 'status' && m.bridge === false);
  assert.equal(statuses.length, 0);
});
