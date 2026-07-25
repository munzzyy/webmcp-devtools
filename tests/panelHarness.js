// tests/panelHarness.js
//
// A tiny, dependency-free DOM + chrome shim so panel.js can be driven under
// `node --test`. The repo keeps the chrome.*-touching files thin on purpose,
// but the panel's frame-state and tool-identity logic has real edge cases
// (duplicate names, navigation, read errors) worth pinning, and importing the
// real panel.js against a fake DOM tests that logic directly rather than a copy
// of it. This is NOT a general DOM: it implements exactly what panel.js touches
// (textContent, appendChild/removeChild/firstChild, addEventListener, class,
// setAttribute, hidden, value, classList.add, createElement/createTextNode).

const PANEL_IDS = [
  'app', 'status-bar', 'tools-section', 'tools-toolbar', 'refresh-btn', 'tools-count',
  'tools-table', 'tools-tbody', 'detail-section', 'detail-name', 'detail-description',
  'detail-schema', 'detail-findings', 'execute-form', 'execute-args', 'execute-error',
  'execute-result', 'timeline-section', 'timeline-toolbar', 'clear-timeline-btn', 'timeline-list',
];

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._text = '';
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.classList = { add: () => {}, remove: () => {}, contains: () => false };
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  appendChild(node) {
    this.children.push(node);
    node.parent = this;
    return node;
  }

  removeChild(node) {
    this.children = this.children.filter((c) => c !== node);
    return node;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event });
  }

  // Depth-first collect of descendants with a given tag (test helper).
  queryTag(tag) {
    const out = [];
    for (const child of this.children) {
      if (child instanceof FakeNode) {
        if (child.tag === tag) out.push(child);
        out.push(...child.queryTag(tag));
      }
    }
    return out;
  }
}

class FakeText {
  constructor(text) {
    this._text = String(text);
    this.children = [];
  }

  get textContent() {
    return this._text;
  }
}

/**
 * Load a fresh instance of panel.js against a fresh fake DOM + chrome. Returns
 * handles for driving and inspecting it.
 */
export async function loadPanel() {
  const byId = new Map();
  for (const id of PANEL_IDS) byId.set(id, new FakeNode('div'));

  const document = {
    body: new FakeNode('body'),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
  };

  let messageHandler = null;
  const sent = [];
  const port = {
    onMessage: { addListener: (fn) => { messageHandler = fn; } },
    postMessage: (msg) => { sent.push(msg); },
  };

  const chrome = {
    devtools: {
      inspectedWindow: { tabId: 1 },
      panels: { themeName: 'default' },
    },
    runtime: { connect: () => port },
  };

  globalThis.document = document;
  globalThis.chrome = chrome;

  // Cache-bust so each test re-evaluates panel.js's module-level state.
  await import(`../panel.js?h=${loadPanel.counter++}`);

  return {
    emit: (msg) => messageHandler && messageHandler(msg),
    sent,
    el: (id) => byId.get(id),
    text: (id) => byId.get(id).textContent,
    rows: () => byId.get('tools-tbody').children,
  };
}
loadPanel.counter = 0;
