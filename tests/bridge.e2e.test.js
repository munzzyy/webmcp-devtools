// tests/bridge.e2e.test.js
//
// The one thing the vm harness cannot prove: that a MAIN-world content script
// in a real Chrome sees a page-installed document.modelContext across the
// isolated-world boundary, that the manifest injection order delivers the
// nonce handshake before any page script runs, and that the relay actually
// crosses worlds. Loads the real extension (plus probe scripts) into headless
// Chromium against tests/fixtures/registertool-page.html, which registers
// tools via document.modelContext.registerTool, and against native-page.html,
// which uses Chrome's native WebMCP in a page and a same-origin iframe.
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

// Records each tools message and executeResult as JSON, and once forges an executeTool for
// getBalance with the nonce read off a bridge message, the way any page script could.
const NATIVE_PROBE_JS = `(() => {
  let forged = false;
  const record = (text) => {
    const el = document.createElement('div');
    el.className = 'e2e-native-msg';
    el.textContent = text;
    (document.body || document.documentElement).appendChild(el);
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.webmcpDevtools !== 'bridge') return;
    if (d.type === 'tools' && Array.isArray(d.tools)) {
      record('tools|' + JSON.stringify(d.tools.map((t) => ({ name: t.name, toolId: t.toolId, ownFrame: t.ownFrame, framePath: t.framePath }))));
      const target = d.tools.find((t) => t.name === 'getBalance' && t.ownFrame === true);
      if (target && !forged) {
        forged = true;
        window.postMessage({
          webmcpDevtools: 'content', nonce: d.nonce, type: 'executeTool', callId: 'e2e-forged',
          toolId: target.toolId, toolName: 'getBalance', argsJson: '{"account":"main"}',
        }, '*');
      }
    }
    if (d.type === 'executeResult') {
      record('exec|' + JSON.stringify({ ok: d.ok, result: d.result === undefined ? null : d.result, error: d.error || null }));
    }
  });
})();
`;

function buildHarnessExtension(tmp, { native = false } = {}) {
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
    js: native ? ['probe.js', 'native-probe.js'] : ['probe.js'],
    all_frames: true,
    run_at: 'document_start',
  });
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(ext, 'probe.js'), PROBE_JS);
  writeFileSync(path.join(ext, 'port-probe.js'), PORT_PROBE_JS);
  if (native) writeFileSync(path.join(ext, 'native-probe.js'), NATIVE_PROBE_JS);
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

// Per request, so a Chrome that stops answering fails the test instead of hanging it.
const CDP_TIMEOUT_MS = 10000;

function connectDevTools(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    const failAll = (err) => {
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    };
    const openTimer = setTimeout(() => {
      reject(new Error('DevTools WebSocket never opened'));
      ws.close();
    }, CDP_TIMEOUT_MS);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener('error', () => {
      clearTimeout(openTimer);
      reject(new Error('DevTools WebSocket failed'));
      failAll(new Error('DevTools WebSocket failed'));
    });
    ws.addEventListener('close', () => failAll(new Error('DevTools WebSocket closed')));
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}) {
          nextId += 1;
          const id = nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} got no answer in ${CDP_TIMEOUT_MS} ms`));
            }, CDP_TIMEOUT_MS);
            pending.set(id, {
              resolve: (value) => { clearTimeout(timer); res(value); },
              reject: (err) => { clearTimeout(timer); rej(err); },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    });
  });
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Killing only the main process leaves renderers writing into the profile while it is deleted.
async function stopChrome(child, exited) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    // ESRCH: the whole group is already gone
  }
  await exited;
  const until = Date.now() + 5000;
  while (groupAlive(child.pid) && Date.now() < until) await sleep(50);
}

function removeQuietly(t, dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    t.diagnostic(`left ${dir} behind: ${err.message}`);
  }
}

// Opens url in Chrome with the harness extension and hands drive() the page and its deadline.
async function withChromePage(chrome, tmp, ext, url, featureFlag, drive, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const profile = path.join(tmp, 'profile');
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--load-extension=${ext}`,
    featureFlag,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile)) {
      if (child.exitCode !== null) throw new Error(`chrome exited with code ${child.exitCode} before DevTools came up`);
      if (Date.now() > deadline) throw new Error('DevTools never came up');
      await sleep(100);
    }
    let devtoolsPort = '';
    while (!devtoolsPort) {
      if (Date.now() > deadline) throw new Error('DevToolsActivePort never got a port');
      devtoolsPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (!devtoolsPort) await sleep(50);
    }
    const listing = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
    const targets = await listing.json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target to drive');
    const devtools = await connectDevTools(page.webSocketDebuggerUrl);
    try {
      await devtools.send('Page.navigate', { url });
      const evaluate = async (expression) => {
        const { result } = await devtools.send('Runtime.evaluate', { expression, returnByValue: true });
        return result ? result.value : undefined;
      };
      return await drive(evaluate, deadline);
    } finally {
      devtools.close();
    }
  } finally {
    await stopChrome(child, exited);
  }
}

// Returns the page's HTML once settled(html) holds, or whatever it has at the deadline.
function loadInChrome(chrome, tmp, ext, url, settled) {
  // Chrome 154 enables native WebMCP by default; this test is about the page's own.
  return withChromePage(chrome, tmp, ext, url, '--disable-features=WebMCP', async (evaluate, deadline) => {
    let html = '';
    while (Date.now() < deadline) {
      const value = await evaluate('document.documentElement.outerHTML');
      html = typeof value === 'string' ? value : '';
      if (settled(html)) break;
      await sleep(200);
    }
    return html;
  });
}

function skipOrFail(t, reason) {
  if (process.env.WEBMCP_E2E_REQUIRED === '1') assert.fail(`${reason} (and WEBMCP_E2E_REQUIRED=1)`);
  t.skip(reason);
}

// Returns a Chrome binary, or null after skipping (or failing, when required) with the reason.
function e2eChrome(t) {
  if (process.env.WEBMCP_E2E !== '1') {
    skipOrFail(t, 'e2e did not run: set WEBMCP_E2E=1 to load the extension into headless Chrome');
    return null;
  }
  if (typeof WebSocket !== 'function') {
    skipOrFail(t, 'e2e did not run: it needs the built-in WebSocket of Node 22 or later');
    return null;
  }
  const chrome = findChrome();
  if (!chrome) skipOrFail(t, 'e2e did not run: no Chrome/Chromium binary found (set CHROME_BIN)');
  return chrome;
}

test('MAIN-world bridge sees a page-installed modelContext in real Chrome', async (t) => {
  const chrome = e2eChrome(t);
  if (!chrome) return;

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
    assert.ok(/E2EPORT\|ok:tools:[^<:]*tallyItems/.test(dom), 'tallyItems never reached the Port in a tools message' + seen);
    assert.ok(/E2EPORT\|ok:tools:[^<:]*frozenTool/.test(dom), 'the frozen descriptor never registered' + seen);
  } finally {
    server.close();
    removeQuietly(t, tmp);
  }
});

const NATIVE_CHECK = `(() => {
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'modelContext');
  return !!(desc && typeof desc.get === 'function' && document.modelContext && desc.get.call(document) === document.modelContext);
})()`;

const nativeMessages = (frameExpr) => `(() => {
  const doc = ${frameExpr};
  return doc ? [...doc.querySelectorAll('.e2e-native-msg')].map((el) => el.textContent) : [];
})()`;

const parseMessages = (texts, kind) => (texts || [])
  .filter((text) => text.startsWith(`${kind}|`))
  .map((text) => JSON.parse(text.slice(kind.length + 1)));

const listsAll = (list, names) => names.every((name) => list.some((tool) => tool.name === name));

test('the bridge works against Chrome\'s native WebMCP across frames', async (t) => {
  const chrome = e2eChrome(t);
  if (!chrome) return;

  const tmp = mkdtempSync(path.join(tmpdir(), 'webmcp-e2e-'));
  const { server, port } = await serveFixtures();
  try {
    const ext = buildHarnessExtension(tmp, { native: true });
    const url = `http://127.0.0.1:${port}/native-page.html`;
    // Chromium 153 needs the testing flag; Chrome 154 and later have native WebMCP on by default.
    const seen = await withChromePage(chrome, tmp, ext, url, '--enable-features=WebMCPTesting', async (evaluate, deadline) => {
      let state = { native: null, top: [], child: [] };
      while (Date.now() < deadline) {
        state = {
          native: await evaluate(NATIVE_CHECK),
          top: await evaluate(nativeMessages('document')),
          child: await evaluate(nativeMessages("document.getElementById('child') && document.getElementById('child').contentDocument")),
          ports: await evaluate("[...document.querySelectorAll('.e2e-port-msg')].map((el) => el.textContent)"),
        };
        if (state.native === false) return state;
        const done = parseMessages(state.top, 'exec').length > 0
          && parseMessages(state.top, 'tools').some((list) => listsAll(list, ['childTool', 'lateTool']))
          && parseMessages(state.child, 'tools').some((list) => listsAll(list, ['childTool', 'getBalance']));
        if (done) return state;
        await sleep(200);
      }
      return state;
    });

    if (seen.native === false) {
      skipOrFail(t, 'e2e did not run: this Chrome has no native WebMCP (document.modelContext is not its own ModelContext)');
      return;
    }
    const dump = `\nmessages seen:\n${JSON.stringify(seen, null, 1)}`;
    const topLists = parseMessages(seen.top, 'tools');
    const childLists = parseMessages(seen.child, 'tools');

    // Native getTools() returns fresh objects every call; the id must not follow them.
    const balanceIds = topLists.map((list) => list.find((tool) => tool.name === 'getBalance')).filter(Boolean).map((tool) => tool.toolId);
    assert.ok(balanceIds.length >= 2, 'getBalance was listed fewer than twice' + dump);
    assert.equal(new Set(balanceIds).size, 1, `getBalance changed ids: ${balanceIds.join(', ')}` + dump);

    const byName = (list) => Object.fromEntries(list.map((tool) => [tool.name, tool]));
    const topList = topLists.find((list) => listsAll(list, ['childTool', 'lateTool']));
    assert.ok(topList, 'the top frame never listed childTool and lateTool together' + dump);
    const top = byName(topList);
    assert.deepEqual([top.getBalance?.ownFrame, top.getBalance?.framePath], [true, 'top'], 'getBalance in the top frame' + dump);
    assert.deepEqual([top.frozenTool?.ownFrame, top.frozenTool?.framePath], [true, 'top'], 'the frozen descriptor in the top frame' + dump);
    assert.deepEqual([top.childTool?.ownFrame, top.childTool?.framePath], [false, 'top.0'], 'childTool as the top frame lists it' + dump);

    const childList = childLists.find((list) => listsAll(list, ['childTool', 'getBalance']));
    assert.ok(childList, 'the child frame never listed childTool and getBalance together' + dump);
    const child = byName(childList);
    assert.deepEqual([child.childTool?.ownFrame, child.childTool?.framePath], [true, 'top.0'], 'childTool in its own frame' + dump);
    assert.deepEqual([child.getBalance?.ownFrame, child.getBalance?.framePath], [false, 'top'], 'getBalance as the child frame lists it' + dump);

    const [exec] = parseMessages(seen.top, 'exec');
    assert.equal(exec.ok, true, 'the forged executeTool failed' + dump);
    assert.deepEqual(exec.result, { cents: 1200, account: 'main' });

    const throws = (seen.ports || []).filter((text) => text.startsWith('E2EPORT|THROW'));
    assert.deepEqual(throws, [], 'the Port refused a message' + dump);
  } finally {
    server.close();
    removeQuietly(t, tmp);
  }
});
