// page-bridge.js
//
// MAIN-world half of the bridge. Chrome isolated worlds share DOM nodes but
// NOT JS expando properties, so an isolated-world content script can never
// see a `document.modelContext` that the page (or a polyfill like
// @mcp-b/webmcp-polyfill) installed itself -- only a native WebIDL attribute
// shows up in every world. This script runs in the page's own world, reads
// document.modelContext there, and relays getTools/executeTool/toolchange to
// the isolated-world content.js over window.postMessage.
//
// Handshake: content.js runs first (manifest order), generates a nonce, and
// leaves it in a data attribute on <html>. This script runs immediately after
// -- still before any page script -- reads the attribute, and removes it.
// Every relayed message carries that nonce and content.js drops anything
// without it. Note the honest limit: once messages start flowing, a page
// script listening on window can read the nonce out of them, so the nonce is
// a message-integrity aid, not a hard boundary. That is fine, because every
// byte this channel carries is page-owned data already -- a page forging
// bridge messages can only lie about its own tools, which it could equally do
// by registering them. The privileged side (the chrome.runtime Port) never
// leaves the isolated world.
//
// SECURITY: this file holds no extension API access at all (no chrome.*). It
// reads page-controlled data and posts inert copies. It never evals anything
// and never touches the DOM beyond the handshake attribute.

(() => {
  'use strict';

  const root = document.documentElement;
  const nonce = root ? root.getAttribute('data-webmcp-devtools-nonce') : null;
  if (root && nonce !== null) root.removeAttribute('data-webmcp-devtools-nonce');
  // Without the handshake nothing we post could be trusted, so stay inert;
  // content.js times out and reports the bridge as missing (loudly).
  if (nonce === null || nonce === '') return;

  const POLL_INTERVAL_MS = 500;
  const POLL_MAX_MS = 30000;
  const REWRAP_WATCH_MS = 2000;

  // Stable identity across re-enumeration: a registry-backed implementation
  // returns the same live tool objects from every getTools() call, so keying
  // ids on object identity (not position) keeps a tool's id fixed while other
  // tools register and unregister around it. Positional ids renumbered every
  // toolchange, which silently re-pointed the panel's selection at a
  // different tool -- and could execute it.
  const toolIds = new WeakMap();
  let nextToolId = 1;
  let toolCache = new Map(); // toolId -> live tool object

  let wrappedTarget = null;
  let observingExecute = false;
  let observingRegister = false;
  const trackedRegistrations = []; // descriptors seen via registerTool, for getTools-less builds
  let panelCallDepth = 0; // panel-initiated executions report via executeResult, not observedCall
  let handlerSuppressDepth = 0; // an observed executeTool call must not double-log via the handler wrapper

  function post(msg) {
    try {
      window.postMessage(Object.assign({ webmcpDevtools: 'bridge', nonce }, msg), '*');
    } catch (err) {
      // A non-cloneable payload must not kill the bridge. Degrade to an error
      // message the panel can show instead of silence.
      try {
        window.postMessage({
          webmcpDevtools: 'bridge',
          nonce,
          type: 'tools',
          origin: safeOrigin(),
          hasModelContext: true,
          tools: [],
          error: `relaying tools failed: ${describeError(err)}`,
        }, '*');
      } catch (err2) {
        // nothing left to do
      }
    }
  }

  function surfaces() {
    let doc = null;
    let nav = null;
    try { doc = document.modelContext || null; } catch (err) { doc = null; }
    try { nav = (typeof navigator !== 'undefined' && navigator.modelContext) || null; } catch (err) { nav = null; }
    return { doc, nav };
  }

  function capabilitiesOf(mc) {
    return {
      getTools: !!(mc && typeof mc.getTools === 'function'),
      executeTool: !!(mc && typeof mc.executeTool === 'function'),
      registerTool: !!(mc && typeof mc.registerTool === 'function'),
    };
  }

  function announceStatus() {
    const { doc, nav } = surfaces();
    post({
      type: 'status',
      origin: safeOrigin(),
      hasModelContext: !!doc,
      surfaces: { document: !!doc, navigator: !!nav },
      capabilities: capabilitiesOf(doc),
      observing: { executeTool: observingExecute, registerTool: observingRegister },
      toolCount: toolCache.size,
    });
  }

  async function announceTools() {
    const { doc } = surfaces();
    if (!doc) {
      post({ type: 'tools', origin: safeOrigin(), hasModelContext: false, tools: [] });
      return;
    }
    ensureWrapped(doc);
    const caps = capabilitiesOf(doc);
    if (caps.getTools) {
      try {
        const rawTools = await doc.getTools();
        if (!Array.isArray(rawTools)) {
          post({
            type: 'tools',
            origin: safeOrigin(),
            hasModelContext: true,
            tools: [],
            error: `getTools() returned ${typeof rawTools}, not an array`,
          });
          return;
        }
        const nextCache = new Map();
        const projected = [];
        for (const raw of rawTools) {
          const toolId = idFor(raw);
          nextCache.set(toolId, raw);
          projected.push(projectTool(raw, toolId, 'getTools'));
        }
        toolCache = nextCache;
        post({ type: 'tools', origin: safeOrigin(), hasModelContext: true, tools: projected });
      } catch (err) {
        post({ type: 'tools', origin: safeOrigin(), hasModelContext: true, tools: [], error: describeError(err) });
      }
      return;
    }
    // No getTools() on this build (the explainer specifies registerTool first
    // and leaves discovery as a TODO). Fall back to the registrations this
    // bridge observed through the wrapped registerTool -- anything registered
    // before the bridge installed is invisible, which the status message says.
    const nextCache = new Map();
    const projected = [];
    for (const desc of trackedRegistrations) {
      const toolId = idFor(desc);
      nextCache.set(toolId, desc);
      projected.push(projectTool(desc, toolId, 'registerTool'));
    }
    toolCache = nextCache;
    post({ type: 'tools', origin: safeOrigin(), hasModelContext: true, tools: projected });
  }

  function idFor(raw) {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) {
      nextToolId += 1;
      return `t${nextToolId - 1}`;
    }
    let id = toolIds.get(raw);
    if (id === undefined) {
      id = `t${nextToolId}`;
      nextToolId += 1;
      toolIds.set(raw, id);
    }
    return id;
  }

  // Strips non-cloneable/live fields and otherwise leaves the tool exactly as
  // the page provided it. Parsing/normalization happens in the panel via
  // core/normalizeTool.js so that logic stays in one pure, unit-tested place.
  function projectTool(raw, toolId, via) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      toolId,
      via,
      name: cloneSafe(src.name),
      description: cloneSafe(src.description),
      inputSchema: cloneSafe(src.inputSchema),
      annotations: cloneSafe(src.annotations),
      origin: typeof src.origin === 'string' ? src.origin : safeOrigin(),
    };
  }

  // postMessage structured-clones its payload, which supports cycles and
  // BigInt but throws on functions/symbols/DOM nodes. Pass clean values
  // through untouched; degrade anything else to a lossy JSON string the
  // panel's normalizeTool already knows how to parse.
  function cloneSafe(value) {
    try {
      structuredClone(value);
      return value;
    } catch (err) {
      try {
        const seen = new WeakSet();
        return JSON.stringify(value, (key, v) => {
          if (typeof v === 'bigint') return `${v}n`;
          if (typeof v === 'function') return '[Function]';
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          return v;
        });
      } catch (err2) {
        return '[unserializable value]';
      }
    }
  }

  function ensureWrapped(mc) {
    if (!mc || wrappedTarget === mc) return;
    wrappedTarget = mc;
    observingExecute = false;
    observingRegister = false;

    try {
      if (typeof mc.addEventListener === 'function') {
        mc.addEventListener('toolchange', onToolchange);
      }
    } catch (err) {
      // a hostile or broken implementation must never break the bridge
    }

    // Wrap executeTool so page/agent-initiated calls through the page-visible
    // surface land in the timeline. Panel-initiated calls are suppressed here
    // (they report through executeResult) so nothing is logged twice.
    try {
      const originalExecute = mc.executeTool;
      if (typeof originalExecute === 'function') {
        const wrapped = function executeTool(...args) {
          return observeExecuteCall(mc, originalExecute, args);
        };
        mc.executeTool = wrapped;
        observingExecute = mc.executeTool === wrapped;
      }
    } catch (err) {
      observingExecute = false;
    }

    // Wrap registerTool for two reasons: instrumenting each descriptor's
    // execute handler observes calls that never go through executeTool (the
    // native agent path invokes the registered handler directly), and the
    // tracked descriptors let a getTools-less build still enumerate what
    // registered after the bridge installed.
    try {
      const originalRegister = mc.registerTool;
      if (typeof originalRegister === 'function') {
        const wrapped = function registerTool(descriptor, options) {
          instrumentDescriptor(descriptor);
          trackRegistration(descriptor, options);
          return originalRegister.call(mc, descriptor, options);
        };
        mc.registerTool = wrapped;
        observingRegister = mc.registerTool === wrapped;
      }
    } catch (err) {
      observingRegister = false;
    }
  }

  function onToolchange() {
    post({ type: 'toolchange', origin: safeOrigin(), timestamp: Date.now() });
    void announceTools();
  }

  function instrumentDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.execute !== 'function') return;
    const original = descriptor.execute;
    descriptor.execute = function execute(...args) {
      return observeHandlerCall(descriptor, original, this, args);
    };
  }

  function trackRegistration(descriptor, options) {
    if (!descriptor || typeof descriptor !== 'object') return;
    trackedRegistrations.push(descriptor);
    const signal = options && options.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      try {
        signal.addEventListener('abort', () => {
          const i = trackedRegistrations.indexOf(descriptor);
          if (i !== -1) trackedRegistrations.splice(i, 1);
          post({ type: 'toolchange', origin: safeOrigin(), timestamp: Date.now() });
          void announceTools();
        }, { once: true });
      } catch (err) {
        // ignore
      }
    }
  }

  async function observeExecuteCall(mc, original, args) {
    if (panelCallDepth > 0) return original.apply(mc, args);
    const timestamp = Date.now();
    const toolArg = args[0];
    const toolName = toolArg && typeof toolArg.name === 'string' ? toolArg.name : '(unknown tool)';
    handlerSuppressDepth += 1;
    try {
      const result = await original.apply(mc, args);
      post({
        type: 'observedCall', origin: safeOrigin(), initiator: 'page', toolName,
        argsJson: lossyJson(args[1]), ok: true, result: toCloneable(result), timestamp,
      });
      return result;
    } catch (err) {
      post({
        type: 'observedCall', origin: safeOrigin(), initiator: 'page', toolName,
        argsJson: lossyJson(args[1]), ok: false, error: describeError(err), timestamp,
      });
      throw err;
    } finally {
      handlerSuppressDepth -= 1;
    }
  }

  async function observeHandlerCall(descriptor, original, thisArg, args) {
    if (panelCallDepth > 0 || handlerSuppressDepth > 0) return original.apply(thisArg, args);
    const timestamp = Date.now();
    const toolName = descriptor && typeof descriptor.name === 'string' ? descriptor.name : '(unnamed tool)';
    try {
      const result = await original.apply(thisArg, args);
      post({
        type: 'observedCall', origin: safeOrigin(), initiator: 'page', toolName,
        argsJson: lossyJson(args[0]), ok: true, result: toCloneable(result), timestamp,
      });
      return result;
    } catch (err) {
      post({
        type: 'observedCall', origin: safeOrigin(), initiator: 'page', toolName,
        argsJson: lossyJson(args[0]), ok: false, error: describeError(err), timestamp,
      });
      throw err;
    }
  }

  async function handleExecuteTool(msg) {
    const { callId, toolId, toolName, argsJson } = msg;
    const timestamp = Date.now();
    const fail = (error) => post({
      type: 'executeResult', callId, toolId, toolName, argsJson, ok: false, error, timestamp,
    });

    const { doc } = surfaces();
    if (!doc) {
      fail('document.modelContext is not present on this page');
      return;
    }
    const tool = toolCache.get(toolId);
    if (!tool) {
      fail(`Unknown tool "${toolName}" -- try Refresh to reload the tool list first`);
      return;
    }

    // The explainer's registered handlers take a parsed object
    // (`async execute({ text })`), so parse the panel's JSON text and hand
    // over an object. Legacy shims that JSON.parse the argument themselves
    // get one retry with the raw string, keyed to TypeError -- the error a
    // WebIDL surface raises on a wrong argument type before running anything.
    let argsValue;
    let argsParsed = false;
    try {
      argsValue = JSON.parse(typeof argsJson === 'string' && argsJson.trim() !== '' ? argsJson : '{}');
      argsParsed = true;
    } catch (err) {
      argsValue = argsJson;
    }

    panelCallDepth += 1;
    try {
      let result;
      if (typeof doc.executeTool === 'function') {
        try {
          result = await doc.executeTool(tool, argsValue);
        } catch (err) {
          if (argsParsed && err && err.name === 'TypeError') {
            result = await doc.executeTool(tool, argsJson);
          } else {
            throw err;
          }
        }
      } else if (typeof tool.execute === 'function') {
        result = await tool.execute(argsValue);
      } else {
        throw new Error('this page has no executeTool() and the tool has no execute handler');
      }
      post({ type: 'executeResult', callId, toolId, toolName, argsJson, ok: true, result: toCloneable(result), timestamp });
    } catch (err) {
      fail(describeError(err));
    } finally {
      panelCallDepth -= 1;
    }
  }

  // executeTool's result is entirely page-defined and might not survive the
  // structured-clone trip. Round-trip it through JSON so post() can never
  // throw; anything that can't survive JSON becomes a plain string.
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

  function lossyJson(value) {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (key, v) => {
        if (typeof v === 'bigint') return `${v}n`;
        if (typeof v === 'function') return '[Function]';
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
    } catch (err) {
      return '[unserializable arguments]';
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
    } catch (err2) {
      return 'Unknown error';
    }
  }

  // ---- commands from the isolated world -----------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.webmcpDevtools !== 'content' || data.nonce !== nonce) return;
    if (data.type === 'getTools') {
      announceStatus();
      void announceTools();
    } else if (data.type === 'executeTool') {
      void handleExecuteTool(data);
    }
  });

  // ---- startup ------------------------------------------------------------

  post({ type: 'bridge-ready' });
  announceStatus();

  const initial = surfaces();
  if (initial.doc) {
    ensureWrapped(initial.doc);
    announceStatus();
    void announceTools();
  } else {
    // modelContext may be installed at any point in the page load (a polyfill,
    // or the page's own script). Poll briefly for its appearance.
    const start = Date.now();
    const pollTimer = setInterval(() => {
      const { doc } = surfaces();
      if (doc) {
        clearInterval(pollTimer);
        ensureWrapped(doc);
        announceStatus();
        void announceTools();
        return;
      }
      if (Date.now() - start > POLL_MAX_MS) clearInterval(pollTimer);
    }, POLL_INTERVAL_MS);
  }

  // A page can replace document.modelContext outright after the wrap (which
  // would orphan the wrappers and the toolchange listener). Watch for that
  // cheaply and re-wrap; a swapped-out registry is exactly the kind of
  // mid-session change this panel exists to surface.
  setInterval(() => {
    const { doc } = surfaces();
    if (doc && doc !== wrappedTarget) {
      announceStatus();
      void announceTools();
    } else if (!doc && wrappedTarget) {
      wrappedTarget = null;
      observingExecute = false;
      observingRegister = false;
      toolCache = new Map();
      announceStatus();
      post({ type: 'tools', origin: safeOrigin(), hasModelContext: false, tools: [] });
    }
  }, REWRAP_WATCH_MS);
})();
