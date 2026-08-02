// tests/bridge.test.js
//
// Drives the real page-bridge.js through the worldHarness fakes. Covers the
// behavior a hostile or shifting page can otherwise exploit: stable tool
// identity across toolchange, nonce-gated commands, argument shapes for both
// spec and legacy executeTool implementations, hostile schemas in transit,
// and observation of page-initiated calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBridge } from './worldHarness.js';

function specModelContext(initialTools = []) {
  const registry = new Map(); // name -> descriptor (live object, stable identity)
  const listeners = [];
  const mc = {
    addEventListener(type, fn) {
      if (type === 'toolchange') listeners.push(fn);
    },
    registerTool(descriptor, options) {
      registry.set(descriptor.name, descriptor);
      for (const fn of listeners) fn();
      return Promise.resolve();
    },
    unregister(name) {
      registry.delete(name);
      for (const fn of listeners) fn();
    },
    async getTools() {
      return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async executeTool(tool, args) {
      const desc = registry.get(tool && tool.name);
      if (!desc) throw new Error(`Unknown tool: ${tool && tool.name}`);
      return desc.execute(args);
    },
  };
  for (const t of initialTools) registry.set(t.name, t);
  return mc;
}

const tool = (name, extra = {}) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  execute: async (args) => ({ ran: name, args }),
  ...extra,
});

test('without the handshake nonce the bridge stays inert', async () => {
  const b = loadBridge({ nonce: null, modelContext: specModelContext([tool('getWeather')]) });
  await b.flush();
  assert.equal(b.posted.length, 0);
});

test('the bridge consumes the nonce attribute so the page can never read it', async () => {
  const b = loadBridge({ modelContext: specModelContext() });
  assert.equal(b.document.documentElement.getAttribute('data-webmcp-devtools-nonce'), null);
  await b.flush();
  assert.ok(b.ofType('bridge-ready').length === 1);
});

test('a page-installed modelContext is detected and its tools announced', async () => {
  const b = loadBridge({ modelContext: specModelContext([tool('getWeather'), tool('addTodo')]) });
  await b.flush();
  const tools = b.ofType('tools');
  assert.ok(tools.length >= 1);
  const last = tools[tools.length - 1];
  assert.equal(last.hasModelContext, true);
  assert.deepEqual([...last.tools.map((t) => t.name)].sort(), ['addTodo', 'getWeather']);
  const status = b.ofType('status').pop();
  assert.equal(status.surfaces.document, true);
  assert.equal(status.capabilities.getTools, true);
});

test('toolIds are stable across re-enumeration and toolchange', async () => {
  const mc = specModelContext([tool('addTodo'), tool('getWeather'), tool('summarizePage')]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();

  const first = b.ofType('tools').pop();
  const idOf = (msg, name) => msg.tools.find((t) => t.name === name).toolId;
  const weatherId = idOf(first, 'getWeather');
  const summarizeId = idOf(first, 'summarizePage');

  // Unregistering addTodo shifts every index -- ids must not move with them.
  mc.unregister('addTodo');
  await b.flush();
  const second = b.ofType('tools').pop();
  assert.equal(second.tools.length, 2);
  assert.equal(idOf(second, 'getWeather'), weatherId);
  assert.equal(idOf(second, 'summarizePage'), summarizeId);

  // A new registration gets a new id; existing ids still do not move.
  mc.registerTool(tool('aaaFirst'));
  await b.flush();
  const third = b.ofType('tools').pop();
  assert.equal(idOf(third, 'getWeather'), weatherId);
  const newId = idOf(third, 'aaaFirst');
  assert.notEqual(newId, weatherId);
  assert.notEqual(newId, summarizeId);
});

test('executeTool commands run the tool addressed by id, with parsed-object args', async () => {
  const seen = [];
  const mc = specModelContext([
    tool('getWeather', { execute: async (args) => { seen.push(args); return { tempF: 68 }; } }),
  ]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const id = b.ofType('tools').pop().tools[0].toolId;

  b.send({ type: 'executeTool', callId: 'c1', toolId: id, toolName: 'getWeather', argsJson: '{"city":"Reno"}' });
  await b.flush();

  const result = b.ofType('executeResult').pop();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { tempF: 68 });
  // The registered handler must receive an object, not the raw JSON string.
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ city: 'Reno' }]);
});

test('a legacy shim that JSON.parses its args itself still works via the string retry', async () => {
  const registry = new Map([['echo', { name: 'echo' }]]);
  const mc = {
    async getTools() { return [...registry.values()]; },
    async executeTool(t, argsJson) {
      if (typeof argsJson !== 'string') throw new TypeError('argsJson must be a string');
      return { echoed: JSON.parse(argsJson) };
    },
  };
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const id = b.ofType('tools').pop().tools[0].toolId;

  b.send({ type: 'executeTool', callId: 'c1', toolId: id, toolName: 'echo', argsJson: '{"a":1}' });
  await b.flush();
  const result = b.ofType('executeResult').pop();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { echoed: { a: 1 } });
});

test('commands without the right nonce are ignored', async () => {
  let executions = 0;
  const mc = specModelContext([tool('getWeather', { execute: async () => { executions += 1; return {}; } })]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const id = b.ofType('tools').pop().tools[0].toolId;
  const bridgeCount = () => b.posted.filter((m) => m && m.webmcpDevtools === 'bridge').length;
  const before = bridgeCount();

  b.send({ type: 'executeTool', callId: 'x', toolId: id, toolName: 'getWeather', argsJson: '{}' }, 'wrong-nonce');
  b.send({ type: 'getTools' }, 'wrong-nonce');
  await b.flush();

  assert.equal(executions, 0);
  assert.equal(bridgeCount(), before);
});

test('a page-initiated executeTool call is observed; panel-initiated calls are not double-logged', async () => {
  const mc = specModelContext([tool('getWeather')]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const id = b.ofType('tools').pop().tools[0].toolId;

  // Panel-initiated: executeResult only, no observedCall.
  b.send({ type: 'executeTool', callId: 'c1', toolId: id, toolName: 'getWeather', argsJson: '{}' });
  await b.flush();
  assert.equal(b.ofType('observedCall').length, 0);
  assert.equal(b.ofType('executeResult').length, 1);

  // Page-initiated (through the wrapped page-visible surface): observed.
  await b.document.modelContext.executeTool({ name: 'getWeather' }, { city: 'Reno' });
  await b.flush();
  const observed = b.ofType('observedCall');
  assert.equal(observed.length, 1, JSON.stringify(observed));
  assert.equal(observed[0].toolName, 'getWeather');
  assert.equal(observed[0].initiator, 'page');
  assert.equal(observed[0].ok, true);
  assert.equal(observed[0].argsJson, '{"city":"Reno"}');
});

test('an agent-style direct handler call on a registered tool is observed exactly once', async () => {
  const mc = specModelContext([]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();

  // Registered AFTER the bridge wrapped registerTool, so its execute handler
  // is instrumented -- the path a native agent takes without executeTool.
  const desc = tool('addNote');
  await b.document.modelContext.registerTool(desc);
  await b.flush();
  b.posted.length = 0;

  await desc.execute({ text: 'hi' });
  await b.flush();
  const observed = b.ofType('observedCall');
  assert.equal(observed.length, 1, JSON.stringify(observed));
  assert.equal(observed[0].toolName, 'addNote');

  // The same handler reached through executeTool must log once, not twice.
  b.posted.length = 0;
  await b.document.modelContext.executeTool({ name: 'addNote' }, { text: 'again' });
  await b.flush();
  assert.equal(b.ofType('observedCall').length, 1);
});

test('a registerTool-only build (no getTools) still enumerates observed registrations', async () => {
  const listeners = [];
  const mc = {
    addEventListener(type, fn) { if (type === 'toolchange') listeners.push(fn); },
    registerTool(descriptor) { for (const fn of listeners) fn(); return Promise.resolve(); },
  };
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const status = b.ofType('status').pop();
  assert.equal(status.capabilities.getTools, false);
  assert.equal(status.surfaces.document, true);

  await b.document.modelContext.registerTool(tool('getInventory'));
  await b.flush();
  const tools = b.ofType('tools').pop();
  assert.deepEqual([...tools.tools.map((t) => t.name)], ['getInventory']);
  assert.equal(tools.tools[0].via, 'registerTool');
});

test('a circular schema survives projection and the tools message still arrives', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } } };
  schema.self = schema;
  const mc = specModelContext([tool('looped', { inputSchema: schema })]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const tools = b.ofType('tools').pop();
  assert.equal(tools.tools.length, 1);
  // structured clone supports cycles, so the schema passes through intact
  assert.equal(tools.tools[0].inputSchema.self, tools.tools[0].inputSchema);
});

test('a schema carrying a function degrades to a lossy string instead of killing the message', async () => {
  const mc = specModelContext([tool('funky', { inputSchema: { type: 'object', evil: () => {} } })]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const tools = b.ofType('tools').pop();
  assert.equal(tools.tools.length, 1);
  assert.equal(typeof tools.tools[0].inputSchema, 'string');
  assert.ok(tools.tools[0].inputSchema.includes('[Function]'));
});

test('the navigator-only legacy surface is reported distinctly', async () => {
  const b = loadBridge({ navigatorModelContext: { getTools: async () => [] } });
  await b.flush();
  const status = b.ofType('status').pop();
  assert.equal(status.surfaces.document, false);
  assert.equal(status.surfaces.navigator, true);
  assert.equal(status.hasModelContext, false);
});
