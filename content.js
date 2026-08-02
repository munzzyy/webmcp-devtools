// content.js
//
// Isolated-world half of the bridge. Chrome isolated worlds share DOM nodes
// but NOT JS expando properties, so this script cannot read a page-installed
// `document.modelContext` itself -- that is page-bridge.js's job, running in
// the MAIN world (see manifest.json; this file runs first, the bridge second,
// both at document_start and both before any page script).
//
// This file's job is the privileged side: it alone holds the
// chrome.runtime Port to the background relay, so the page never touches an
// extension API. It generates a per-frame nonce, hands it to the bridge
// through a DOM attribute that is set and consumed before the page can run,
// and then forwards only well-formed, nonce-carrying bridge messages to the
// panel -- and panel commands back to the bridge.
//
// SECURITY: everything relayed here (tool name, description, inputSchema,
// annotation values) is page-controlled, untrusted data. This file never
// evals it and never touches the DOM with it -- it only relays it as inert
// data. The only place page strings ever touch a DOM tree is panel.js, and
// only via textContent/createTextNode (see panel.js).

(() => {
  'use strict';

  // Message types the bridge is allowed to send upward. Anything else is
  // dropped, so a forged message cannot invent new panel behavior.
  const BRIDGE_TYPES = new Set(['status', 'tools', 'toolchange', 'observedCall', 'executeResult']);
  const PANEL_TYPES = new Set(['getTools', 'executeTool']);
  const BRIDGE_TIMEOUT_MS = 2000;
  const RECONNECT_BASE_MS = 250;
  const RECONNECT_MAX_MS = 5000;

  const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let bridgeReady = false;
  let port = null;
  let reconnectDelay = RECONNECT_BASE_MS;

  // Handshake: the MAIN-world bridge runs immediately after this script and
  // consumes the attribute before any page script exists to observe it.
  const root = document.documentElement;
  if (root) {
    try {
      root.setAttribute('data-webmcp-devtools-nonce', nonce);
    } catch (err) {
      // if this fails the bridge stays inert and the timeout below reports it
    }
  }

  connectPort();

  window.addEventListener('message', (event) => {
    // Same-window only: a cross-origin frame's postMessage arrives with its
    // own window proxy as `source` and is rejected here.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.webmcpDevtools !== 'bridge' || data.nonce !== nonce) return;
    if (data.type === 'bridge-ready') {
      bridgeReady = true;
      return;
    }
    if (typeof data.type !== 'string' || !BRIDGE_TYPES.has(data.type)) return;
    const msg = {};
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'webmcpDevtools' && key !== 'nonce') msg[key] = value;
    }
    if (data.type === 'status') msg.bridge = true;
    postSafe(msg);
  });

  // If the bridge never checks in, this page cannot be inspected at all.
  // Say so explicitly: a silent "not found" here would be indistinguishable
  // from a clean page, which is the one failure mode a security tool must
  // never have.
  setTimeout(() => {
    if (bridgeReady) return;
    postSafe({
      type: 'status',
      origin: safeOrigin(),
      bridge: false,
      hasModelContext: false,
      surfaces: { document: false, navigator: false },
      capabilities: {},
      observing: {},
      toolCount: 0,
    });
  }, BRIDGE_TIMEOUT_MS);

  function onPanelMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !PANEL_TYPES.has(msg.type)) return;
    reconnectDelay = RECONNECT_BASE_MS; // traffic means the port is healthy
    forwardToBridge(msg);
  }

  function forwardToBridge(msg) {
    try {
      window.postMessage(Object.assign({ webmcpDevtools: 'content', nonce }, msg), '*');
    } catch (err) {
      // non-cloneable panel message; nothing to relay
    }
  }

  // An MV3 service-worker cycle (extension reload, update, worker crash, the
  // chrome://extensions toggle) closes this Port. Without reconnecting, the
  // frame goes silent forever and the panel keeps showing stale tools --
  // reconnect with capped backoff, then re-announce through the bridge.
  function connectPort() {
    let p;
    try {
      p = chrome.runtime.connect({ name: 'webmcp-content' });
    } catch (err) {
      return; // extension context invalidated; a page reload starts fresh
    }
    port = p;
    p.onMessage.addListener(onPanelMessage);
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      setTimeout(() => {
        connectPort();
        if (port) forwardToBridge({ type: 'getTools' });
      }, delay);
    });
  }

  function postSafe(message) {
    if (!port) return;
    try {
      port.postMessage(message);
    } catch (err) {
      // port already closed; onDisconnect drives the reconnect
    }
  }

  function safeOrigin() {
    try {
      return location.origin;
    } catch (err) {
      return '';
    }
  }
})();
