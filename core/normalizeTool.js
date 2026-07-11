// core/normalizeTool.js
//
// Pure normalization for a raw WebMCP tool object, as forwarded by content.js
// from `document.modelContext.getTools()`. No chrome.* dependency -- this
// file is unit-tested directly with Node's built-in test runner.
//
// The WebMCP spec has `inputSchema` come back as a JSON STRING on the tool
// object, but this function tolerates either a string or an already-parsed
// object (defensive against future spec changes, polyfills, and the demo
// page). It never throws: malformed input degrades to a safe, clearly
// labeled shape instead of crashing the panel. Every field on `raw` is
// page-controlled, untrusted data -- this module only reshapes it, it never
// renders it (rendering with textContent-only is panel.js's job).

const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/**
 * @param {unknown} raw - one entry from getTools(), or a content.js projection of one
 * @returns {{
 *   name: string,
 *   description: string,
 *   inputSchema: object,
 *   inputSchemaError: string | null,
 *   annotations: { readOnlyHint: boolean, untrustedContentHint: boolean, [key: string]: unknown },
 *   origin: string,
 * }}
 */
export function normalizeTool(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const name = typeof src.name === 'string' && src.name.length > 0 ? src.name : '(unnamed tool)';
  const description = typeof src.description === 'string' ? src.description : '';
  const origin = typeof src.origin === 'string' ? src.origin : '';

  const { inputSchema, inputSchemaError } = parseInputSchema(src.inputSchema);
  const annotations = normalizeAnnotations(src.annotations);

  return { name, description, inputSchema, inputSchemaError, annotations, origin };
}

function parseInputSchema(rawSchema) {
  if (rawSchema && typeof rawSchema === 'object') {
    return { inputSchema: rawSchema, inputSchemaError: null };
  }
  if (typeof rawSchema === 'string') {
    if (rawSchema.trim() === '') {
      return { inputSchema: { ...EMPTY_SCHEMA }, inputSchemaError: null };
    }
    try {
      const parsed = JSON.parse(rawSchema);
      if (parsed && typeof parsed === 'object') {
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
