// tests/worldHarness.js
//
// Drives the real content.js (isolated world) and page-bridge.js (MAIN world)
// under `node --test`, the same way panelHarness.js drives panel.js. Both
// files are classic scripts (not modules), so each is evaluated with node:vm
// in a context that fakes exactly what it touches: window.postMessage +
// addEventListener('message'), document.documentElement attributes,
// document.modelContext, chrome.runtime.connect, and timers. postMessage
// delivers synchronously to every registered listener with `source: window`,
// which mirrors the same-window broadcast the real channel uses.
//
// This pins the world-bridge logic (nonce handshake, message validation,
// stable tool identity, call observation, port reconnect) without a browser.
// What it cannot prove -- that a MAIN-world script really sees a
// page-installed modelContext across Chrome's world boundary -- is covered by
// tests/bridge.e2e.test.js against real Chromium.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));

class FakeDocumentElement {
  constructor() {
    this.attrs = new Map();
  }

  setAttribute(key, value) {
    this.attrs.set(key, String(value));
  }

  getAttribute(key) {
    return this.attrs.has(key) ? this.attrs.get(key) : null;
  }

  removeAttribute(key) {
    this.attrs.delete(key);
  }
}

function makeWindow() {
  const listeners = [];
  const posted = [];
  const win = {
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage(data) {
      posted.push(data);
      for (const fn of [...listeners]) fn({ source: win, data });
    },
  };
  const dispatch = (data, source) => {
    for (const fn of [...listeners]) fn({ source, data });
  };
  return { win, listeners, posted, dispatch };
}

// Timers that never keep the node process alive after the tests finish.
function makeTimers() {
  return {
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    },
    clearInterval,
  };
}

function runScript(file, context) {
  const code = readFileSync(path.join(here, '..', file), 'utf8');
  vm.createContext(context);
  new vm.Script(code, { filename: file }).runInContext(context);
  return context;
}

/**
 * Loads the real page-bridge.js against a fake MAIN world.
 * `nonce: null` skips the handshake attribute so the inert path can be tested.
 */
export function loadBridge({ nonce = 'test-nonce', modelContext, navigatorModelContext } = {}) {
  const { win, posted } = makeWindow();
  const documentElement = new FakeDocumentElement();
  if (nonce !== null) documentElement.setAttribute('data-webmcp-devtools-nonce', nonce);

  const doc = { documentElement };
  if (modelContext !== undefined) doc.modelContext = modelContext;

  const context = {
    window: win,
    document: doc,
    navigator: navigatorModelContext !== undefined ? { modelContext: navigatorModelContext } : {},
    location: { origin: 'https://page.example' },
    structuredClone,
    console,
    Date,
    ...makeTimers(),
  };
  runScript('page-bridge.js', context);

  return {
    // every message the bridge posted (bridge envelope included)
    posted,
    ofType: (type) => posted.filter((m) => m && m.webmcpDevtools === 'bridge' && m.type === type),
    // emulate the isolated world sending a command (with or without the nonce)
    send: (msg, useNonce = nonce) => win.postMessage({ webmcpDevtools: 'content', nonce: useNonce, ...msg }),
    document: doc,
    window: win,
    // let async announce/execute work settle
    flush: async (rounds = 4) => {
      for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/**
 * Loads the real content.js against a fake isolated world.
 */
export function loadContent() {
  const { win, posted, dispatch } = makeWindow();
  const documentElement = new FakeDocumentElement();

  const connects = [];
  const chrome = {
    runtime: {
      connect: () => {
        const sent = [];
        const port = {
          sent,
          messageHandlers: [],
          disconnectHandlers: [],
          onMessage: { addListener(fn) { port.messageHandlers.push(fn); } },
          onDisconnect: { addListener(fn) { port.disconnectHandlers.push(fn); } },
          postMessage(msg) { sent.push(msg); },
          emit(msg) { for (const fn of port.messageHandlers) fn(msg); },
          disconnect() { for (const fn of port.disconnectHandlers) fn(); },
        };
        connects.push(port);
        return port;
      },
    },
  };

  const context = {
    window: win,
    document: { documentElement },
    location: { origin: 'https://page.example' },
    chrome,
    crypto: { randomUUID: () => `uuid-${connects.length}-${Math.random().toString(36).slice(2)}` },
    console,
    Date,
    ...makeTimers(),
  };
  runScript('content.js', context);

  return {
    nonce: documentElement.getAttribute('data-webmcp-devtools-nonce'),
    documentElement,
    window: win,
    posted, // window messages content.js posted toward the bridge
    connects, // every port chrome.runtime.connect handed out, in order
    port: () => connects[connects.length - 1],
    // emulate the bridge posting upward; `source` other than the window
    // itself emulates a cross-origin frame's forgery attempt
    postAsBridge: (msg, { nonce, source } = {}) => {
      const data = { webmcpDevtools: 'bridge', nonce, ...msg };
      dispatch(data, source === undefined ? win : source);
    },
  };
}
