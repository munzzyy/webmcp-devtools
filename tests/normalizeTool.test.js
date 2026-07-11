import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTool } from '../core/normalizeTool.js';

test('normalizeTool parses a stringified inputSchema (the real WebMCP shape)', () => {
  const tool = normalizeTool({
    name: 'addTodo',
    description: 'Add a todo',
    inputSchema: JSON.stringify({ type: 'object', properties: { text: { type: 'string' } } }),
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    origin: 'https://example.com',
  });

  assert.equal(tool.name, 'addTodo');
  assert.equal(tool.description, 'Add a todo');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: { text: { type: 'string' } } });
  assert.equal(tool.inputSchemaError, null);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.untrustedContentHint, false);
  assert.equal(tool.origin, 'https://example.com');
});

test('normalizeTool tolerates an already-parsed object inputSchema', () => {
  const tool = normalizeTool({
    name: 'getWeather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  });

  assert.deepEqual(tool.inputSchema, { type: 'object', properties: { city: { type: 'string' } } });
  assert.equal(tool.inputSchemaError, null);
});

test('normalizeTool never throws on malformed JSON and returns a safe shape', () => {
  assert.doesNotThrow(() => {
    const tool = normalizeTool({ name: 'broken', inputSchema: '{not valid json' });
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
    assert.match(tool.inputSchemaError, /not valid JSON/);
  });
});

test('normalizeTool handles inputSchema JSON that parses to a non-object (e.g. a bare number)', () => {
  const tool = normalizeTool({ name: 'weird', inputSchema: '42' });
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
  assert.match(tool.inputSchemaError, /non-object/);
});

test('normalizeTool handles a missing inputSchema without error', () => {
  const tool = normalizeTool({ name: 'noSchema' });
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
  assert.equal(tool.inputSchemaError, null);
});

test('normalizeTool handles missing annotations by defaulting both hints to false', () => {
  const tool = normalizeTool({ name: 'noAnnotations' });
  assert.deepEqual(tool.annotations, { readOnlyHint: false, untrustedContentHint: false });
});

test('normalizeTool coerces non-boolean annotation hints to strict booleans', () => {
  const tool = normalizeTool({ name: 't', annotations: { readOnlyHint: 'yes', untrustedContentHint: 1 } });
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.untrustedContentHint, false);
});

test('normalizeTool preserves unknown extra annotation keys', () => {
  const tool = normalizeTool({ name: 't', annotations: { readOnlyHint: true, customHint: 'extra' } });
  assert.equal(tool.annotations.customHint, 'extra');
  assert.equal(tool.annotations.readOnlyHint, true);
});

test('normalizeTool never throws on completely empty/undefined/null input', () => {
  assert.doesNotThrow(() => normalizeTool(undefined));
  assert.doesNotThrow(() => normalizeTool(null));
  assert.doesNotThrow(() => normalizeTool('not an object'));
  assert.doesNotThrow(() => normalizeTool(42));

  const tool = normalizeTool(undefined);
  assert.equal(tool.name, '(unnamed tool)');
  assert.equal(tool.description, '');
  assert.equal(tool.origin, '');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
});

test('normalizeTool falls back to "(unnamed tool)" for a missing/empty name', () => {
  assert.equal(normalizeTool({}).name, '(unnamed tool)');
  assert.equal(normalizeTool({ name: '' }).name, '(unnamed tool)');
  assert.equal(normalizeTool({ name: 123 }).name, '(unnamed tool)');
});

test('normalizeTool treats an empty-string inputSchema as an empty object schema, not an error', () => {
  const tool = normalizeTool({ name: 't', inputSchema: '' });
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
  assert.equal(tool.inputSchemaError, null);
});
