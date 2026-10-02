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
  const MAX_FRAME_DEPTH = 32;
  const MAX_SIBLING_FRAMES = 1000;

  // Ids never follow list position: a positional id re-pointed the panel's selection, and Execute, at a different tool.
  const toolIds = new WeakMap(); // live tool object -> toolId
  // Native getTools() returns fresh objects on every call, so those key on the (window, name) pair native executeTool resolves by.
  const idsByWindow = new WeakMap(); // tool.window, or OWN_WINDOW -> Map(name -> toolId)
  const OWN_WINDOW = {};
  let nextToolId = 1;
  let toolCache = new Map(); // toolId -> live tool object

  let wrappedTarget = null;
  let observingExecute = false;
  let observingRegister = false;
  let unwrappedHandlers = 0; // registered handlers the bridge could not wrap, so direct calls to them go unseen
  const trackedRegistrations = []; // descriptors seen via registerTool, for getTools-less builds
  let panelCallDepth = 0; // panel-initiated executions report via executeResult, not observedCall
  let handlerSuppressDepth = 0; // an observed executeTool call must not double-log via the handler wrapper

  // Read before any page script runs, so a page cannot pass its own object off as native.
  const nativeModelContextGetter = (() => {
    try {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'modelContext');
      return desc && typeof desc.get === 'function' ? desc.get : null;
    } catch (err) {
      return null;
    }
  })();

  function isNativeModelContext(mc) {
    if (!nativeModelContextGetter) return false;
    try {
      return nativeModelContextGetter.call(document) === mc;
    } catch (err) {
      return false;
    }
  }

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
      observing: { executeTool: observingExecute, registerTool: observingRegister, unwrappedHandlers },
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
        const taken = new Set();
        const paths = new Map();
        for (const raw of rawTools) {
          const toolId = idFor(raw, taken);
          nextCache.set(toolId, raw);
          const win = toolWindow(raw);
          const own = win === null || win === window;
          if (!paths.has(win)) paths.set(win, framePath(own ? window : win));
          projected.push(projectTool(raw, toolId, 'getTools', own, paths.get(win)));
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
    const taken = new Set();
    const ownPath = framePath(window);
    for (const desc of trackedRegistrations) {
      const toolId = idFor(desc, taken);
      nextCache.set(toolId, desc);
      projected.push(projectTool(desc, toolId, 'registerTool', true, ownPath));
    }
    toolCache = nextCache;
    post({ type: 'tools', origin: safeOrigin(), hasModelContext: true, tools: projected });
  }

  // `taken` holds the ids this listing already gave out; unnamed tools and a repeated pair fall back to object identity.
  function idFor(raw, taken) {
    let id;
    if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
      id = toolIds.get(raw);
      if (id === undefined || taken.has(id)) {
        const name = toolName(raw);
        id = name === null ? undefined : idForPair(toolWindow(raw), name);
        if (id === undefined || taken.has(id)) id = mintId();
        toolIds.set(raw, id);
      }
    } else {
      id = mintId();
    }
    taken.add(id);
    return id;
  }

  function idForPair(win, name) {
    const scope = win === null || win === window ? OWN_WINDOW : win;
    let byName = idsByWindow.get(scope);
    if (!byName) {
      byName = new Map();
      idsByWindow.set(scope, byName);
    }
    let id = byName.get(name);
    if (id === undefined) {
      id = mintId();
      byName.set(name, id);
    }
    return id;
  }

  function mintId() {
    const id = `t${nextToolId}`;
    nextToolId += 1;
    return id;
  }

  function toolName(raw) {
    try {
      const name = raw.name;
      return typeof name === 'string' && name !== '' ? name : null;
    } catch (err) {
      return null;
    }
  }

  // Native tools carry the window that registered them; polyfill tools usually carry none.
  function toolWindow(raw) {
    try {
      const win = raw.window;
      return win !== null && typeof win === 'object' ? win : null;
    } catch (err) {
      return null;
    }
  }

  // Child-frame indexes from the top window ("top.0.1"), the same string whichever frame works it out.
  function framePath(win) {
    try {
      const steps = [];
      let w = win;
      for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
        const parent = w.parent;
        if (parent === w) return ['top', ...steps.reverse()].join('.');
        if (!parent) return null;
        const count = parent.length;
        if (typeof count !== 'number' || count > MAX_SIBLING_FRAMES) return null;
        let index = -1;
        for (let i = 0; i < count; i += 1) {
          if (parent[i] === w) {
            index = i;
            break;
          }
        }
        if (index === -1) return null;
        steps.push(index);
        w = parent;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  // Strips non-cloneable/live fields and otherwise leaves the tool exactly as
  // the page provided it. Parsing/normalization happens in the panel via
  // core/normalizeTool.js so that logic stays in one pure, unit-tested place.
  // `degraded` names the fields sent as a lossy copy.
  function projectTool(raw, toolId, via, ownFrame, path) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const degraded = [];
    const field = (key) => {
      const value = src[key];
      if (survivesPort(value)) return value;
      degraded.push(key);
      return lossyCopy(value, [], 0);
    };
    const projection = {
      toolId,
      via,
      name: field('name'),
      title: field('title'),
      description: field('description'),
      inputSchema: field('inputSchema'),
      annotations: field('annotations'),
      origin: typeof src.origin === 'string' ? src.origin : safeOrigin(),
      ownFrame,
      framePath: path,
    };
    if (degraded.length > 0) projection.degraded = degraded;
    return projection;
  }

  // The Port JSON-encodes the structured clone, which has lost prototypes and any inherited toJSON.
  function survivesPort(value) {
    try {
      JSON.stringify(structuredClone(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  const MAX_COPY_DEPTH = 32;

  // Keeps the shape, with markers in place of BigInt ("1n"), functions and cycles.
  function lossyCopy(value, ancestors, depth) {
    const t = typeof value;
    if (value === null || t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'bigint') return `${value}n`;
    if (t === 'function') return '[Function]';
    if (t === 'symbol') return '[Symbol]';
    if (t !== 'object') return null;
    if (depth >= MAX_COPY_DEPTH) return '[MaxDepth]';
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);
    let out;
    try {
      if (Array.isArray(value)) {
        out = [];
        for (let i = 0; i < value.length; i += 1) out.push(lossyCopy(value[i], ancestors, depth + 1));
      } else {
        out = {};
        for (const key of Object.keys(value)) {
          let child;
          try {
            child = value[key];
          } catch (err) {
            child = '[Unreadable]';
          }
          if (child !== undefined) out[key] = lossyCopy(child, ancestors, depth + 1);
        }
      }
    } catch (err) {
      out = '[Unreadable]';
    }
    ancestors.pop();
    return out;
  }

  function ensureWrapped(mc) {
    if (!mc || wrappedTarget === mc) return;
    wrappedTarget = mc;
    observingExecute = false;
    observingRegister = false;
    unwrappedHandlers = 0;

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
          const registered = instrumentDescriptor(descriptor);
          trackRegistration(mc, registered, options);
          return originalRegister.call(mc, registered, options);
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

  // Returns what to register: the descriptor wrapped in place, or a wrapped copy when its execute is read-only.
  function instrumentDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return descriptor;
    let original;
    try {
      original = descriptor.execute;
    } catch (err) {
      return descriptor;
    }
    if (typeof original !== 'function') return descriptor;
    const inPlace = function execute(...args) {
      return observeHandlerCall(descriptor, original, this, args);
    };
    try {
      descriptor.execute = inPlace;
      if (descriptor.execute === inPlace) return descriptor;
    } catch (err) {
      // frozen, or execute is a getter or non-writable
    }
    try {
      return wrappedCopy(descriptor, original);
    } catch (err) {
      unwrappedHandlers += 1;
      announceStatus();
      return descriptor;
    }
  }

  // Same prototype and own properties, so the page's registry gets an equivalent descriptor.
  function wrappedCopy(descriptor, original) {
    const props = Object.getOwnPropertyDescriptors(descriptor);
    let copy = null;
    const execute = function execute(...args) {
      return observeHandlerCall(descriptor, original, this === copy ? descriptor : this, args);
    };
    const existing = props.execute;
    props.execute = { value: execute, writable: true, enumerable: existing ? existing.enumerable : true, configurable: true };
    copy = Object.create(Object.getPrototypeOf(descriptor), props);
    if (Object.isFrozen(descriptor)) Object.freeze(copy);
    else if (Object.isSealed(descriptor)) Object.seal(copy);
    else if (!Object.isExtensible(descriptor)) Object.preventExtensions(copy);
    return copy;
  }

  function trackRegistration(mc, descriptor, options) {
    if (!descriptor || typeof descriptor !== 'object') return;
    trackedRegistrations.push(descriptor);
    const signal = options && options.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      try {
        signal.addEventListener('abort', () => {
          const i = trackedRegistrations.indexOf(descriptor);
          if (i !== -1) trackedRegistrations.splice(i, 1);
          // Native has already dropped the tool and fires its own toolchange later, so relisting now would show a same-task re-register as a removal.
          if (isNativeModelContext(mc) && capabilitiesOf(mc).getTools) return;
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
      const shown = isNativeModelContext(mc) ? decodeNativeResult(result) : result;
      post({
        type: 'observedCall', origin: safeOrigin(), initiator: 'page', toolName,
        argsJson: lossyJson(args[1]), ok: true, result: toCloneable(shown), timestamp,
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
    const argsText = typeof argsJson === 'string' && argsJson.trim() !== '' ? argsJson : '{}';
    let argsValue;
    let argsParsed = false;
    try {
      argsValue = JSON.parse(argsText);
      argsParsed = true;
    } catch (err) {
      argsValue = argsJson;
    }

    panelCallDepth += 1;
    try {
      let result;
      if (typeof doc.executeTool === 'function' && isNativeModelContext(doc)) {
        // Native takes only a JSON string, and a handler that throws rejects with the same UnknownError as bad arguments, so never retry.
        result = decodeNativeResult(await doc.executeTool(tool, argsText));
      } else if (typeof doc.executeTool === 'function') {
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

  // Native executeTool resolves to the handler's result as a JSON string. Polyfill results are never decoded, so a string stays a string.
  function decodeNativeResult(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (err) {
      return value;
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
