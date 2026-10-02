// tests/bridge.e2e.test.js
//
// The one thing the vm harness cannot prove: that a MAIN-world content script
// in a real Chrome sees a page-installed document.modelContext across the
// isolated-world boundary, that the manifest injection order delivers the
// nonce handshake before any page script runs, and that the relay actually
// crosses worlds. Loads the real extension (plus read-only probe scripts)
// into headless Chromium against tests/fixtures/registertool-page.html, which
// registers tools via document.modelContext.registerTool.
// Driven over CDP (Node 22+), because --dump-dom never returns in Chrome for Testing 154.
//
// Opt-in and loud about it: run with
//
//   WEBMCP_E2E=1 node --test tests/bridge.e2e.test.js
//
// When the env var or a Chrome binary is missing the test SKIPS with a "did
// not run" message -- it never silently passes. WEBMCP_E2E_REQUIRED=1 (set in
// CI) turns that skip into a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ].filter(Boolean);
  for (const bin of candidates) {
    const which = spawnSync('which', [bin], { encoding: 'utf8' });
    if (which.status === 0) return which.stdout.trim();
  }
  return null;
}

// The probe runs in the same isolated world as content.js and mirrors every
// bridge-envelope window message into the DOM, where the test reads it.
// Read-only: it validates nothing and changes nothing about the extension
// under test.
const PROBE_JS = `window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || typeof d !== 'object' || d.webmcpDevtools !== 'bridge') return;
  let text = String(d.type);
  if (d.type === 'tools') text += ':' + (Array.isArray(d.tools) ? d.tools.map((t) => t && t.name).join(',') : '?');
  if (d.type === 'observedCall') text += ':' + d.toolName + ':' + (d.ok ? 'ok' : 'err');
  if (d.type === 'status') text += ':doc=' + String(d.surfaces && d.surfaces.document);
  const el = document.createElement('div');
  el.className = 'e2e-bridge-msg';
  el.textContent = 'E2E|' + text;
  (document.body || document.documentElement).appendChild(el);
});
`;

// Runs before content.js and records every port.postMessage outcome; it rethrows.
const PORT_PROBE_JS = `(() => {
  const record = (text) => {
    const el = document.createElement('div');
    el.className = 'e2e-port-msg';
    el.textContent = 'E2EPORT|' + text;
    (document.body || document.documentElement).appendChild(el);
  };
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const post = port.postMessage.bind(port);
    port.postMessage = (msg) => {
      try {
        post(msg);
      } catch (err) {
        record('THROW:' + (err && err.message));
        throw err;
      }
      let text = 'ok:' + String(msg && msg.type);
      if (msg && msg.type === 'tools') {
        text += ':' + (Array.isArray(msg.tools) ? msg.tools.map((t) => t && t.name).join(',') : '?');
        if (msg.error) text += ':error=' + msg.error;
      }
      record(text);
    };
    return port;
  };
})();
`;

function buildHarnessExtension(tmp) {
  const ext = path.join(tmp, 'ext');
  mkdirSync(ext);
  const manifest = JSON.parse(readFileSync(path.join(repo, 'manifest.json'), 'utf8'));
  manifest.content_scripts.unshift({
    matches: ['<all_urls>'],
    js: ['port-probe.js'],
    all_frames: true,
    run_at: 'document_start',
  });
  manifest.content_scripts.push({
    matches: ['<all_urls>'],
    js: ['probe.js'],
    all_frames: true,
    run_at: 'document_start',
  });
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(ext, 'probe.js'), PROBE_JS);
  writeFileSync(path.join(ext, 'port-probe.js'), PORT_PROBE_JS);
  for (const file of ['content.js', 'page-bridge.js', 'background.js', 'devtools.html', 'devtools.js']) {
    copyFileSync(path.join(repo, file), path.join(ext, file));
  }
  mkdirSync(path.join(ext, 'icons'));
  for (const icon of readdirSync(path.join(repo, 'icons'))) {
    copyFileSync(path.join(repo, 'icons', icon), path.join(ext, 'icons', icon));
  }
  return ext;
}

function serveFixtures() {
  const server = createServer((req, res) => {
    try {
      const file = path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(readFileSync(file));
    } catch (err) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connectDevTools(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket failed')));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        nextId += 1;
        const id = nextId;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    }));
  });
}

// Returns the page's HTML once settled(html) holds, or whatever it has at the deadline.
async function loadInChrome(chrome, tmp, ext, url, settled, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const profile = path.join(tmp, 'profile');
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--load-extension=${ext}`,
    // Chrome 154 enables native WebMCP by default; this test is about the page's own.
    '--disable-features=WebMCP',
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile)) {
      if (child.exitCode !== null) throw new Error(`chrome exited with code ${child.exitCode} before DevTools came up`);
      if (Date.now() > deadline) throw new Error('DevTools never came up');
      await sleep(100);
    }
    let devtoolsPort = '';
    while (!devtoolsPort && Date.now() < deadline) {
      devtoolsPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (!devtoolsPort) await sleep(50);
    }
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target to drive');
    const devtools = await connectDevTools(page.webSocketDebuggerUrl);
    try {
      await devtools.send('Page.navigate', { url });
      let html = '';
      while (Date.now() < deadline) {
        const { result } = await devtools.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
        html = result && typeof result.value === 'string' ? result.value : '';
        if (settled(html)) break;
        await sleep(200);
      }
      return html;
    } finally {
      devtools.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  }
}

function skipOrFail(t, reason) {
  if (process.env.WEBMCP_E2E_REQUIRED === '1') assert.fail(`${reason} (and WEBMCP_E2E_REQUIRED=1)`);
  t.skip(reason);
}

test('MAIN-world bridge sees a page-installed modelContext in real Chrome', async (t) => {
  if (process.env.WEBMCP_E2E !== '1') {
    skipOrFail(t, 'e2e did not run: set WEBMCP_E2E=1 to load the extension into headless Chrome');
    return;
  }
  if (typeof WebSocket !== 'function') {
    skipOrFail(t, 'e2e did not run: it needs the built-in WebSocket of Node 22 or later');
    return;
  }
  const chrome = findChrome();
  if (!chrome) {
    skipOrFail(t, 'e2e did not run: no Chrome/Chromium binary found (set CHROME_BIN)');
    return;
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'webmcp-e2e-'));
  const { server, port } = await serveFixtures();
  try {
    const ext = buildHarnessExtension(tmp);
    const url = `http://127.0.0.1:${port}/registertool-page.html`;
    // addNote is the fixture's last step; after it, give the Port side a moment.
    const windowDone = (html) => /E2E\|tools:[^<]*addNote/.test(html) && html.includes('E2E|observedCall:getInventory');
    const dom = await loadInChrome(chrome, tmp, ext, url, (html) => {
      if (!windowDone(html)) return false;
      if (!windowDone.at) windowDone.at = Date.now();
      return Date.now() - windowDone.at > 750;
    });

    // Every probe marker, so a failure in CI says what did arrive.
    const seen = `\nmarkers seen:\n${(dom.match(/E2E(?:PORT)?\|[^<]*/g) || []).join('\n')}`;
    // The handshake completed and the bridge came up.
    assert.ok(dom.includes('E2E|bridge-ready'), 'bridge never checked in' + seen);
    // The MAIN world saw the page's modelContext...
    assert.ok(dom.includes('E2E|status:doc=true'), 'bridge never reported the page-installed modelContext' + seen);
    // ...enumerated the registerTool-registered tool across the world boundary...
    assert.ok(/E2E\|tools:[^<]*getInventory/.test(dom), 'getInventory never showed up in a tools message' + seen);
    // ...observed a page-initiated executeTool call...
    assert.ok(dom.includes('E2E|observedCall:getInventory:ok'), 'the page-initiated call was not observed' + seen);
    // ...and relayed the late registration's toolchange.
    assert.ok(dom.includes('E2E|toolchange'), 'toolchange was not relayed' + seen);
    assert.ok(/E2E\|tools:[^<]*addNote/.test(dom), 'the late-registered tool never showed up' + seen);
    // The page could not read the handshake nonce.
    assert.ok(dom.includes('nonce-steal:null'), 'the page saw the handshake nonce' + seen);
    // countItems has a BigInt default: it must reach the Port, and nothing may be refused.
    const throws = dom.match(/E2EPORT\|THROW:[^<]*/g) || [];
    assert.deepEqual(throws, [], 'the Port refused a message' + seen);
    assert.ok(/E2EPORT\|ok:tools:[^<:]*countItems/.test(dom), 'countItems never reached the Port in a tools message' + seen);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
