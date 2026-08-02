// tests/bridge.e2e.test.js
//
// The one thing the vm harness cannot prove: that a MAIN-world content script
// in a real Chrome sees a page-installed document.modelContext across the
// isolated-world boundary, that the manifest injection order delivers the
// nonce handshake before any page script runs, and that the relay actually
// crosses worlds. Loads the real extension (plus a read-only probe script)
// into headless Chromium against tests/fixtures/registertool-page.html, which
// registers tools via document.modelContext.registerTool.
//
// Opt-in and loud about it: run with
//
//   WEBMCP_E2E=1 node --test tests/bridge.e2e.test.js
//
// When the env var or a Chrome binary is missing the test SKIPS with a "did
// not run" message -- it never silently passes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
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
// bridge-envelope window message into the DOM, where --dump-dom can see it.
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

function buildHarnessExtension(tmp) {
  const ext = path.join(tmp, 'ext');
  mkdirSync(ext);
  const manifest = JSON.parse(readFileSync(path.join(repo, 'manifest.json'), 'utf8'));
  manifest.content_scripts.push({
    matches: ['<all_urls>'],
    js: ['probe.js'],
    all_frames: true,
    run_at: 'document_start',
  });
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(ext, 'probe.js'), PROBE_JS);
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

test('MAIN-world bridge sees a page-installed modelContext in real Chrome', async (t) => {
  if (process.env.WEBMCP_E2E !== '1') {
    t.skip('e2e did not run: set WEBMCP_E2E=1 to load the extension into headless Chrome');
    return;
  }
  const chrome = findChrome();
  if (!chrome) {
    t.skip('e2e did not run: no Chrome/Chromium binary found (set CHROME_BIN)');
    return;
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'webmcp-e2e-'));
  const { server, port } = await serveFixtures();
  try {
    const ext = buildHarnessExtension(tmp);
    const url = `http://127.0.0.1:${port}/registertool-page.html`;
    // Async spawn, not spawnSync: the fixture server lives in this process,
    // so blocking the event loop would deadlock Chrome's page load.
    const dom = await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        '--headless=new',
        '--disable-gpu',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        `--load-extension=${ext}`,
        '--virtual-time-budget=6000',
        '--dump-dom',
        url,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const killer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) resolve(out);
        else reject(new Error(`chrome exited with code ${code}; captured ${out.length} bytes`));
      });
    });

    // The handshake completed and the bridge came up.
    assert.ok(dom.includes('E2E|bridge-ready'), 'bridge never checked in');
    // The MAIN world saw the page's modelContext...
    assert.ok(dom.includes('E2E|status:doc=true'), 'bridge never reported the page-installed modelContext');
    // ...enumerated the registerTool-registered tool across the world boundary...
    assert.ok(/E2E\|tools:[^<]*getInventory/.test(dom), 'getInventory never showed up in a tools message');
    // ...observed a page-initiated executeTool call...
    assert.ok(dom.includes('E2E|observedCall:getInventory:ok'), 'the page-initiated call was not observed');
    // ...and relayed the late registration's toolchange.
    assert.ok(dom.includes('E2E|toolchange'), 'toolchange was not relayed');
    assert.ok(/E2E\|tools:[^<]*addNote/.test(dom), 'the late-registered tool never showed up');
    // The page could not read the handshake nonce.
    assert.ok(dom.includes('nonce-steal:null'), 'the page saw the handshake nonce');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
