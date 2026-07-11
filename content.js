// content.js
//
// Isolated-world bridge. Injected into every frame of every page at
// document_start (see manifest.json). Reads `document.modelContext` directly
// -- it's a native WebIDL attribute on Document, shared with the page's
// main-world DOM, so an isolated-world content script can see it with no
// `world: "MAIN"` injection needed. Works identically whether
// document.modelContext is the native (flagged) implementation or a page
// -loaded polyfill (e.g. @mcp-b/webmcp-polyfill) -- both are just reading a
// Document property.
//
// SECURITY: everything read off `document.modelContext` (tool name,
// description, inputSchema, annotation values) is page-controlled, untrusted
// data. This file never evals it and never touches innerHTML with it -- it
// only relays it as inert data. The only place page strings ever touch a DOM
// tree is panel.js, and only via textContent/createElement (see panel.js).

const port = chrome.runtime.connect({ name: 'webmcp-content' });

// Live tool objects can't be structured-cloned across the messaging boundary
// (each one carries a `window` reference), so the actual objects returned by
// getTools() are cached here, keyed by name, and only a serializable
// projection of each is ever sent to the panel. executeTool-by-name looks
// the real object back up from this cache.
let toolCache = new Map();

let pollTimer = null;
let toolchangeListenerAttached = false;

detectAndAnnounce();
pollForModelContext();

port.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'getTools') {
    void announceTools();
  } else if (msg.type === 'executeTool') {
    void handleExecuteTool(msg);
  }
});

function hasModelContext() {
  return (
    typeof document !== 'undefined' &&
    !!document.modelContext &&
    typeof document.modelContext.getTools === 'function'
  );
}

function detectAndAnnounce() {
  postSafe({
    type: 'status',
    origin: safeOrigin(),
    hasModelContext: hasModelContext(),
    toolCount: toolCache.size,
  });
  if (hasModelContext()) {
    attachToolchangeListener();
    void announceTools();
  }
}

// document.modelContext may not exist yet at document_start -- a polyfill or
// the page's own script can install it later in the page load. Poll briefly
// for its appearance instead of only ever checking once.
function pollForModelContext() {
  if (hasModelContext()) return;
  const start = Date.now();
  const maxMs = 30000;
  pollTimer = setInterval(() => {
    if (hasModelContext()) {
      clearInterval(pollTimer);
      pollTimer = null;
      detectAndAnnounce();
      return;
    }
    if (Date.now() - start > maxMs) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 500);
}

function attachToolchangeListener() {
  if (toolchangeListenerAttached || !hasModelContext()) return;
  try {
    document.modelContext.addEventListener('toolchange', () => {
      postSafe({ type: 'toolchange', origin: safeOrigin(), timestamp: Date.now() });
      void announceTools();
    });
    toolchangeListenerAttached = true;
  } catch (err) {
    // A hostile or broken polyfill could throw here; never let that break the bridge.
  }
}

async function announceTools() {
  if (!hasModelContext()) {
    postSafe({ type: 'tools', origin: safeOrigin(), hasModelContext: false, tools: [] });
    return;
  }
  try {
    const rawTools = await document.modelContext.getTools();
    toolCache = new Map();
    const projected = [];
    for (const raw of Array.isArray(rawTools) ? rawTools : []) {
      const name = raw && typeof raw.name === 'string' ? raw.name : undefined;
      if (name) toolCache.set(name, raw);
      projected.push(projectTool(raw));
    }
    postSafe({ type: 'tools', origin: safeOrigin(), hasModelContext: true, tools: projected });
  } catch (err) {
    postSafe({
      type: 'tools',
      origin: safeOrigin(),
      hasModelContext: true,
      tools: [],
      error: describeError(err),
    });
  }
}

// Strips non-cloneable/live fields (crucially `window`) and otherwise leaves
// the tool exactly as the page provided it -- including inputSchema, which
// may still be the raw JSON string. Real parsing/normalization happens in
// panel.js via core/normalizeTool.js, not here, so that logic exists in one
// pure, unit-tested place.
function projectTool(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    name: src.name,
    description: src.description,
    inputSchema: src.inputSchema,
    annotations: src.annotations,
    origin: typeof src.origin === 'string' ? src.origin : safeOrigin(),
  };
}

async function handleExecuteTool(msg) {
  const { callId, toolName, argsJson } = msg;
  const timestamp = Date.now();

  if (!hasModelContext()) {
    postSafe({
      type: 'executeResult',
      callId,
      toolName,
      argsJson,
      ok: false,
      error: 'document.modelContext is not present on this page',
      timestamp,
    });
    return;
  }

  const tool = toolCache.get(toolName);
  if (!tool) {
    postSafe({
      type: 'executeResult',
      callId,
      toolName,
      argsJson,
      ok: false,
      error: `Unknown tool "${toolName}" -- try Refresh to reload the tool list first`,
      timestamp,
    });
    return;
  }

  try {
    const result = await document.modelContext.executeTool(tool, argsJson);
    postSafe({
      type: 'executeResult',
      callId,
      toolName,
      argsJson,
      ok: true,
      result: toCloneable(result),
      timestamp,
    });
  } catch (err) {
    postSafe({
      type: 'executeResult',
      callId,
      toolName,
      argsJson,
      ok: false,
      error: describeError(err),
      timestamp,
    });
  }
}

// executeTool's result is entirely page-defined and might not be
// structured-clone safe. Round-trip it through JSON so postMessage below can
// never throw a DataCloneError; anything that can't survive JSON becomes a
// plain string instead of crashing the bridge.
function toCloneable(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    try {
      return String(value);
    } catch (err2) {
      return null;
    }
  }
}

function postSafe(message) {
  try {
    port.postMessage(message);
  } catch (err) {
    // Extension context invalidated (e.g. the extension was reloaded) or the
    // port already closed; nothing this frame can do about it.
  }
}

function safeOrigin() {
  try {
    return location.origin;
  } catch (err) {
    return '';
  }
}

function describeError(err) {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch (_e) {
    return 'Unknown error';
  }
}
