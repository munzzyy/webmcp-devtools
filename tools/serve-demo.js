#!/usr/bin/env node
// Usage: node tools/serve-demo.js [port]. Serves examples/, since file:// blocks the demo's module import.

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLES_DIR = path.join(here, '..', 'examples');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Decodes the raw path before the containment check, so "..%2f" cannot slip past it.
export async function resolveDemoFile(rawUrl, root = EXAMPLES_DIR) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawUrl).split(/[?#]/)[0]);
  } catch (err) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/' || decoded === '') decoded = '/demo.html';
  const type = TYPES[path.extname(decoded).toLowerCase()];
  if (!type) return null;
  try {
    const realRoot = await realpath(root);
    const file = await realpath(path.resolve(realRoot, `.${decoded}`));
    if (!file.startsWith(realRoot + path.sep)) return null;
    if (!(await stat(file)).isFile()) return null;
    return { file, type };
  } catch (err) {
    return null;
  }
}

export function createDemoServer(root = EXAMPLES_DIR) {
  return createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('method not allowed\n');
      return;
    }
    const hit = await resolveDemoFile(req.url, root);
    if (!hit) {
      res.statusCode = 404;
      res.end('not found\n');
      return;
    }
    try {
      const body = await readFile(hit.file);
      res.setHeader('content-type', hit.type);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      res.statusCode = 404;
      res.end('not found\n');
    }
  });
}

// Loopback only: the demo has a tool that pretends to run shell commands.
export function startDemoServer(port = 0, root = EXAMPLES_DIR) {
  const server = createDemoServer(root);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { address, port: bound } = server.address();
      resolve({ server, url: `http://${address}:${bound}/demo.html` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const port = arg === undefined ? 0 : Number(arg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`usage: node tools/serve-demo.js [port]   (got "${arg}")`);
    process.exit(2);
  }
  try {
    const { url } = await startDemoServer(port);
    console.log(url);
    console.log('Open that in Chrome with the extension loaded. Ctrl+C stops the server.');
  } catch (err) {
    console.error(`could not start the demo server: ${err.message}`);
    process.exit(1);
  }
}
