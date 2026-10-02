// core/normalizeTool.js
//
// Pure normalization for a raw WebMCP tool object, as forwarded by content.js
// from `document.modelContext.getTools()`. No chrome.* dependency -- this
// file is unit-tested directly with Node's built-in test runner.
//
// The WebMCP explainer shows `inputSchema` as a plain object, but legacy
// shims and some polyfills hand over a JSON string instead, so this function
// tolerates either shape. It never throws: malformed input degrades to a
// safe, clearly labeled shape instead of crashing the panel. Every field on `raw` is
// page-controlled, untrusted data -- this module only reshapes it, it never
// renders it (rendering with textContent-only is panel.js's job).

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/**
 * @param {unknown} raw - one entry from getTools(), or a content.js projection of one
 * @returns {{
 *   toolId: string | null,
 *   name: string,
 *   title: string,
 *   description: string,
 *   inputSchema: object,
 *   inputSchemaError: string | null,
 *   annotations: { readOnlyHint: boolean, untrustedContentHint: boolean, [key: string]: unknown },
 *   origin: string,
 *   degraded: string[],
 * }}
 */
export function normalizeTool(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // Stable per-frame identity assigned by content.js (the tool's position in
  // getTools()). Two tools with the same name -- or several "(unnamed tool)"
  // entries -- stay distinct because the panel addresses them by toolId, not
  // by name. Null when a caller (e.g. a unit test) provides no id.
  const toolId = typeof src.toolId === 'string' ? src.toolId : null;
  const name = typeof src.name === 'string' && src.name.length > 0 ? src.name : '(unnamed tool)';
  const title = typeof src.title === 'string' ? src.title : '';
  const description = typeof src.description === 'string' ? src.description : '';
  const origin = typeof src.origin === 'string' ? src.origin : '';

  const { inputSchema, inputSchemaError } = parseInputSchema(src.inputSchema);
  const annotations = normalizeAnnotations(src.annotations);

  const degraded = normalizeDegraded(src.degraded);

  return { toolId, name, title, description, inputSchema, inputSchemaError, annotations, origin, degraded };
}

// page-bridge.js lists the fields it had to replace with a lossy copy (a
// BigInt, a cycle, a function) so they could cross the extension Port.
const DEGRADABLE_FIELDS = new Set(['name', 'title', 'description', 'inputSchema', 'annotations']);

function normalizeDegraded(rawDegraded) {
  if (!Array.isArray(rawDegraded)) return [];
  return [...new Set(rawDegraded.filter((f) => typeof f === 'string' && DEGRADABLE_FIELDS.has(f)))];
}

function parseInputSchema(rawSchema) {
  // A JSON Schema is an object; an array is not a valid schema even though
  // typeof [] === 'object'. Reject it so it surfaces as a schema error (and a
  // lint finding) instead of being presented as a valid schema that constrains
  // nothing.
  if (rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
    return { inputSchema: rawSchema, inputSchemaError: null };
  }
  if (Array.isArray(rawSchema)) {
    return {
      inputSchema: { ...EMPTY_SCHEMA },
      inputSchemaError: 'inputSchema is a JSON array, not a schema object',
    };
  }
  if (typeof rawSchema === 'string') {
    if (rawSchema.trim() === '') {
      return { inputSchema: { ...EMPTY_SCHEMA }, inputSchemaError: null };
    }
    try {
      const parsed = JSON.parse(rawSchema);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { inputSchema: parsed, inputSchemaError: null };
      }
      return {
        inputSchema: { ...EMPTY_SCHEMA },
        inputSchemaError: 'inputSchema JSON parsed to a non-object value',
      };
    } catch (err) {
      return {
        inputSchema: { ...EMPTY_SCHEMA },
        inputSchemaError: `inputSchema is not valid JSON: ${err.message}`,
      };
    }
  }
  return {
    inputSchema: { ...EMPTY_SCHEMA },
    inputSchemaError: rawSchema === undefined ? null : 'inputSchema missing or an unrecognized type',
  };
}

function normalizeAnnotations(rawAnnotations) {
  const src = rawAnnotations && typeof rawAnnotations === 'object' ? rawAnnotations : {};
  return {
    ...src,
    readOnlyHint: src.readOnlyHint === true,
    untrustedContentHint: src.untrustedContentHint === true,
  };
}
