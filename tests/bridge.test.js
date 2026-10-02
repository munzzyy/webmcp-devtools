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
import { nativeModelContext, nativeTool } from './nativeFake.js';
import { normalizeTool } from '../core/normalizeTool.js';
import { lintTool } from '../lint.js';

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

test('the projection relays a tool title, which native tools carry', async () => {
  const b = loadBridge({ modelContext: specModelContext([tool('getWeather', { title: 'Weather lookup' })]) });
  await b.flush();
  assert.equal(b.ofType('tools').pop().tools[0].title, 'Weather lookup');
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

// Each one threw "Cannot assign to read only property 'execute'" inside the page's own registerTool call.
const readOnlyExecuteDescriptors = (calls) => {
  const handler = (label) => async function execute(args) {
    calls.push({ label, self: this, args });
    return { ran: label };
  };
  const getterExecute = { ...tool('getterTool') };
  delete getterExecute.execute;
  const getterHandler = handler('getterTool');
  Object.defineProperty(getterExecute, 'execute', { get: () => getterHandler, enumerable: true });
  const nonWritable = { ...tool('nonWritableTool') };
  Object.defineProperty(nonWritable, 'execute', { value: handler('nonWritableTool'), writable: false, enumerable: true });
  return [
    Object.freeze({ ...tool('frozenTool'), execute: handler('frozenTool') }),
    getterExecute,
    nonWritable,
  ];
};

test('frozen, getter-execute and read-only-execute descriptors still register, and calls to them are observed once', async () => {
  const mc = specModelContext([]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const calls = [];
  const descriptors = readOnlyExecuteDescriptors(calls);
  for (const desc of descriptors) {
    await assert.doesNotReject(async () => b.document.modelContext.registerTool(desc));
  }
  await b.flush();
  const names = ['frozenTool', 'getterTool', 'nonWritableTool'];
  assert.deepEqual((await mc.getTools()).map((t) => t.name), names);
  assert.deepEqual([...b.ofType('tools').pop().tools.map((t) => t.name)], names);
  assert.ok(Object.isFrozen((await mc.getTools())[0]), 'a frozen descriptor stays frozen in the registry');

  for (const name of names) {
    b.posted.length = 0;
    calls.length = 0;
    await b.document.modelContext.executeTool({ name }, { via: 'executeTool' });
    await b.flush();
    assert.equal(b.ofType('observedCall').length, 1, `${name} via executeTool`);
    assert.equal(calls.length, 1);

    // The agent path: the registry's own handler, called directly.
    b.posted.length = 0;
    calls.length = 0;
    const registered = (await mc.getTools()).find((t) => t.name === name);
    await registered.execute({ via: 'handler' });
    await b.flush();
    const observed = b.ofType('observedCall');
    assert.equal(observed.length, 1, `${name} via its handler: ${JSON.stringify(observed)}`);
    assert.equal(observed[0].toolName, name);
    assert.equal(observed[0].argsJson, '{"via":"handler"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].self, descriptors[names.indexOf(name)], 'the handler sees the page\'s own descriptor as this');
  }
  b.send({ type: 'getTools' });
  await b.flush();
  assert.equal(b.ofType('status').pop().observing.unwrappedHandlers, 0);
});

test('a descriptor the bridge cannot copy still registers, and the status says its calls go unseen', async () => {
  const mc = specModelContext([]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const target = tool('proxiedTool');
  const hostile = new Proxy(target, {
    set: () => false,
    ownKeys: () => { throw new Error('no keys for you'); },
  });
  await assert.doesNotReject(async () => b.document.modelContext.registerTool(hostile));
  await b.flush();
  assert.deepEqual((await mc.getTools()).map((t) => t.name), ['proxiedTool']);
  assert.equal(b.ofType('status').pop().observing.unwrappedHandlers, 1);
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

// JSON.stringify sees only the inherited toJSON; the structured clone the Port encodes drops it.
function maskedBigIntSchema() {
  const schema = Object.create({ toJSON() { return { type: 'object' }; } });
  schema.type = 'object';
  schema.properties = { n: { type: 'integer', default: 1n } };
  return schema;
}

// Each must arrive JSON-safe and still listed, with the lossy field named.
const unserializableTools = () => {
  const looped = { type: 'object', properties: { x: { type: 'string' } } };
  looped.self = looped;
  return [
    ['bigDefault', 'inputSchema', { inputSchema: { type: 'object', properties: { n: { type: 'integer', default: 1n } } } }],
    ['bigAnnotation', 'annotations', { annotations: { readOnlyHint: true, weight: 2n } }],
    ['bigDescription', 'description', { description: 10n }],
    ['looped', 'inputSchema', { inputSchema: looped }],
    ['inheritedToJSON', 'inputSchema', { inputSchema: maskedBigIntSchema() }],
  ];
};

for (const [name, field, extra] of unserializableTools()) {
  test(`a tool with an unserializable ${field} (${name}) is still listed, JSON-safe, with the field marked degraded`, async () => {
    const mc = specModelContext([tool('getWeather'), tool(name, extra)]);
    const b = loadBridge({ modelContext: mc });
    await b.flush();
    const msg = b.ofType('tools').pop();
    assert.doesNotThrow(() => JSON.stringify(msg));
    assert.deepEqual([...msg.tools.map((t) => t.name)].sort(), [name, 'getWeather'].sort());
    const projected = msg.tools.find((t) => t.name === name);
    assert.deepEqual([...projected.degraded], [field]);
    assert.equal(msg.tools.find((t) => t.name === 'getWeather').degraded, undefined);

    // The copy is clean JSON, so the finding has to come from the degraded marker.
    const findings = lintTool(normalizeTool(JSON.parse(JSON.stringify(projected))));
    const hit = findings.find((f) => f.id === 'unserializable');
    assert.ok(hit, JSON.stringify(findings));
    assert.equal(hit.severity, 'medium');
    assert.ok(hit.title.includes(field), hit.title);
  });
}

test('a degraded field keeps its shape with markers in place of the bad values', async () => {
  const [, , { inputSchema: looped }] = unserializableTools()[3];
  const mc = specModelContext([
    tool('bigDefault', { inputSchema: { type: 'object', properties: { n: { type: 'integer', default: 1n } } } }),
    tool('looped', { inputSchema: looped }),
    tool('bigAnnotation', { annotations: { readOnlyHint: true, weight: 2n } }),
  ]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const byName = Object.fromEntries(b.ofType('tools').pop().tools.map((t) => [t.name, t]));
  assert.equal(byName.bigDefault.inputSchema.properties.n.default, '1n');
  assert.equal(byName.looped.inputSchema.self, '[Circular]');
  assert.equal(byName.looped.inputSchema.properties.x.type, 'string');
  assert.equal(byName.bigAnnotation.annotations.readOnlyHint, true);
  assert.equal(byName.bigAnnotation.annotations.weight, '2n');
});

test('a schema carrying a function degrades to a lossy copy instead of killing the message', async () => {
  const mc = specModelContext([tool('funky', { inputSchema: { type: 'object', evil: () => {} } })]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const tools = b.ofType('tools').pop();
  assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0].inputSchema.type, 'object');
  assert.equal(tools.tools[0].inputSchema.evil, '[Function]');
  assert.deepEqual([...tools.tools[0].degraded], ['inputSchema']);
});

test('the navigator-only legacy surface is reported distinctly', async () => {
  const b = loadBridge({ navigatorModelContext: { getTools: async () => [] } });
  await b.flush();
  const status = b.ofType('status').pop();
  assert.equal(status.surfaces.document, false);
  assert.equal(status.surfaces.navigator, true);
  assert.equal(status.hasModelContext, false);
});

async function loadNative(setup) {
  let mc;
  const b = loadBridge({ nativeModelContext: (win) => { mc = nativeModelContext(win); return mc; } });
  await setup(mc, b.window);
  await b.flush();
  return { b, mc };
}

const lastTools = (b) => b.ofType('tools').pop().tools;

test('native tools keep their toolId although getTools() returns fresh objects every time', async () => {
  const { b, mc } = await loadNative(async (mc) => {
    await mc.registerTool(nativeTool('getBalance'));
    await mc.registerTool(nativeTool('addNote'));
  });
  assert.notEqual((await mc.getTools())[0], (await mc.getTools())[0]);
  const first = lastTools(b);
  b.send({ type: 'getTools' });
  await b.flush();
  const second = lastTools(b);
  assert.notEqual(first, second);
  for (const name of ['getBalance', 'addNote']) {
    assert.equal(second.find((t) => t.name === name).toolId, first.find((t) => t.name === name).toolId, name);
  }
  assert.notEqual(second[0].toolId, second[1].toolId);
});

test('two native tools named alike in different frames get their own ids, and each id runs its own handler', async () => {
  const child = { length: 0 };
  const { b, mc } = await loadNative(async (mc, win) => {
    child.parent = win;
    win.length = 1;
    win[0] = child;
    await mc.registerTool(nativeTool('dup', { description: 'The parent one.' }));
    await mc.registerTool(nativeTool('dup', { description: 'The child one.', window: child }));
  });
  const tools = lastTools(b);
  assert.equal(tools.length, 2);
  const parentDup = tools.find((t) => t.description === 'The parent one.');
  const childDup = tools.find((t) => t.description === 'The child one.');
  assert.notEqual(parentDup.toolId, childDup.toolId);
  assert.equal(parentDup.ownFrame, true);
  assert.equal(parentDup.framePath, 'top');
  assert.equal(childDup.ownFrame, false);
  assert.equal(childDup.framePath, 'top.0');

  b.send({ type: 'executeTool', callId: 'c1', toolId: childDup.toolId, toolName: 'dup', argsJson: '{}' });
  await b.flush();
  assert.deepEqual(mc.entries.map((e) => e.runs), [0, 1]);
  b.send({ type: 'executeTool', callId: 'c2', toolId: parentDup.toolId, toolName: 'dup', argsJson: '{}' });
  await b.flush();
  assert.deepEqual(mc.entries.map((e) => e.runs), [1, 1]);
});

test('Execute on native WebMCP sends the arguments as a JSON string and decodes the result', async () => {
  const seen = [];
  const { b, mc } = await loadNative(async (mc) => {
    await mc.registerTool(nativeTool('getBalance', { execute: async (args) => { seen.push(args); return { cents: 1200 }; } }));
  });
  b.send({ type: 'executeTool', callId: 'c1', toolId: lastTools(b)[0].toolId, toolName: 'getBalance', argsJson: '{"account":"main"}' });
  await b.flush();
  const result = b.ofType('executeResult').pop();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { cents: 1200 });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ account: 'main' }]);
  assert.equal(mc.entries[0].runs, 1);
});

test('a native handler that throws runs once: the bridge never retries an UnknownError', async () => {
  const { b, mc } = await loadNative(async (mc) => {
    await mc.registerTool(nativeTool('boom', { execute: async () => { throw new TypeError('kaboom'); } }));
  });
  b.send({ type: 'executeTool', callId: 'c1', toolId: lastTools(b)[0].toolId, toolName: 'boom', argsJson: '{}' });
  await b.flush();
  const result = b.ofType('executeResult').pop();
  assert.equal(result.ok, false);
  assert.match(result.error, /invocation failed/);
  assert.equal(mc.entries[0].runs, 1);
});

test('a page-initiated native executeTool call is observed with its result decoded', async () => {
  const { b } = await loadNative(async (mc) => {
    await mc.registerTool(nativeTool('getBalance', { execute: async () => ({ cents: 1200 }) }));
  });
  const [listed] = await b.document.modelContext.getTools();
  assert.equal(await b.document.modelContext.executeTool(listed, '{}'), '{"cents":1200}', 'the page still gets the string');
  await b.flush();
  const observed = b.ofType('observedCall');
  assert.equal(observed.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(observed[0].result)), { cents: 1200 });
});

test('a polyfill tool that returns a string keeps it a string, through Execute and when observed', async () => {
  const mc = specModelContext([tool('getCount', { execute: async () => '42' })]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  b.send({ type: 'executeTool', callId: 'c1', toolId: lastTools(b)[0].toolId, toolName: 'getCount', argsJson: '{}' });
  await b.flush();
  assert.equal(b.ofType('executeResult').pop().result, '42');
  await b.document.modelContext.executeTool({ name: 'getCount' }, {});
  await b.flush();
  assert.equal(b.ofType('observedCall').pop().result, '42');
});

test('a page object over a native modelContext is not treated as native', async () => {
  const seen = [];
  const polyfill = specModelContext([tool('getWeather', { execute: async (args) => { seen.push(args); return {}; } })]);
  const b = loadBridge({ nativeModelContext: (win) => nativeModelContext(win), modelContext: polyfill });
  await b.flush();
  b.send({ type: 'executeTool', callId: 'c1', toolId: lastTools(b)[0].toolId, toolName: 'getWeather', argsJson: '{"city":"Reno"}' });
  await b.flush();
  assert.equal(b.ofType('executeResult').pop().ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ city: 'Reno' }]);
});

test('a polyfill that lists two tools under one name keeps each id on its own object', async () => {
  const first = tool('dup', { description: 'First.' });
  const second = tool('dup', { description: 'Second.' });
  const listed = [first, second];
  const b = loadBridge({ modelContext: { getTools: async () => [...listed] } });
  await b.flush();
  const before = Object.fromEntries(lastTools(b).map((t) => [t.description, t.toolId]));
  assert.notEqual(before['First.'], before['Second.']);
  listed.reverse();
  b.send({ type: 'getTools' });
  await b.flush();
  const after = Object.fromEntries(lastTools(b).map((t) => [t.description, t.toolId]));
  assert.deepEqual(after, before);
  assert.ok(lastTools(b).every((t) => t.ownFrame === true && t.framePath === 'top'));
});

test('a polyfill that swaps in a new object under a listed name keeps the id, and the id runs the new object', async () => {
  const seen = [];
  const mc = specModelContext([
    tool('getWeather', { description: 'Look up the weather.', execute: async () => { seen.push('old'); return {}; } }),
    tool('addTodo'),
  ]);
  const b = loadBridge({ modelContext: mc });
  await b.flush();
  const before = Object.fromEntries(lastTools(b).map((t) => [t.name, t.toolId]));
  const replacement = tool('getWeather', { description: 'Look up the weather, then post it elsewhere.', execute: async () => { seen.push('new'); return {}; } });
  await b.document.modelContext.registerTool(replacement);
  await b.flush();
  const after = lastTools(b);
  assert.equal(after.find((t) => t.name === 'getWeather').description, 'Look up the weather, then post it elsewhere.');
  assert.deepEqual(Object.fromEntries(after.map((t) => [t.name, t.toolId])), before);

  b.send({ type: 'executeTool', callId: 'c1', toolId: before.getWeather, toolName: 'getWeather', argsJson: '{}' });
  await b.flush();
  assert.equal(b.ofType('executeResult').pop().ok, true);
  assert.deepEqual(seen, ['new']);
});
