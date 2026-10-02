// tools/serve-demo.js: loopback only, and files from examples/ only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startDemoServer } from '../tools/serve-demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Raw request: fetch() would normalize "/../" away before it reached the server.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the demo server binds 127.0.0.1 and serves the demo page and its module', async () => {
  const { server, url } = await startDemoServer(0);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/demo\.html$/);
    const { port } = server.address();

    const page = await rawGet(port, '/demo.html');
    assert.equal(page.status, 200);
    assert.equal(page.type, 'text/html; charset=utf-8');
    assert.ok(page.body.includes('webmcp-devtools demo page'));

    const mod = await rawGet(port, '/demo-tools.js');
    assert.equal(mod.status, 200);
    assert.equal(mod.type, 'text/javascript; charset=utf-8');
  } finally {
    server.close();
  }
});

test('the demo server refuses to serve anything outside examples/', async () => {
  const { server } = await startDemoServer(0);
  try {
    const { port } = server.address();
    for (const rawPath of ['/../lint.js', '/..%2flint.js', '/..%2Flint.js', '/%2e%2e/lint.js', '/../package.json', '/lint.js']) {
      const res = await rawGet(port, rawPath);
      assert.equal(res.status, 404, `${rawPath} -> ${res.status}`);
      assert.ok(!res.body.includes('lintTool'), rawPath);
    }
  } finally {
    server.close();
  }
});

test('running the script prints a loopback URL that serves the demo', async () => {
  const child = spawn(process.execPath, [path.join(here, '..', 'tools', 'serve-demo.js'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no URL printed; got ${JSON.stringify(out)}`)), 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const line = out.split('\n')[0];
        if (out.includes('\n')) {
          clearTimeout(timer);
          resolve(line.trim());
        }
      });
      child.on('error', reject);
    });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.pathname, '/demo.html');
    const res = await rawGet(Number(parsed.port), '/demo.html');
    assert.equal(res.status, 200);
  } finally {
    child.kill();
  }
});
