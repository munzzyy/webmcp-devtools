// tests/manifest.test.js
//
// Not a unit test of application logic -- a structural sanity check that
// manifest.json is valid JSON and carries the MV3 keys this extension
// actually depends on (devtools_page, background service worker, and the
// content script registration). Cheap enough to run every time alongside
// the real core/ tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, '..', 'manifest.json');

test('manifest.json parses as valid JSON', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('manifest.json declares manifest_version 3', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
});

test('manifest.json declares the devtools_page entry point', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.devtools_page, 'devtools.html');
});

test('manifest.json declares a background service worker', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(typeof manifest.background, 'object');
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('manifest.json registers the isolated relay and the MAIN-world bridge, in that order', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Exactly two entries, and the order is load-bearing: content.js (isolated)
  // must run first to leave the handshake nonce on <html>, and page-bridge.js
  // (MAIN world) must run immediately after to consume it -- both at
  // document_start, before any page script exists to observe the attribute.
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 2);
  const [relay, bridge] = manifest.content_scripts;

  assert.deepEqual(relay.js, ['content.js']);
  assert.equal(relay.all_frames, true);
  assert.equal(relay.run_at, 'document_start');
  assert.notEqual(relay.world, 'MAIN'); // the Port holder must stay isolated
  assert.ok(Array.isArray(relay.matches) && relay.matches.length > 0);

  assert.deepEqual(bridge.js, ['page-bridge.js']);
  assert.equal(bridge.all_frames, true);
  assert.equal(bridge.run_at, 'document_start');
  assert.equal(bridge.world, 'MAIN'); // page-installed modelContext is only visible here
  assert.deepEqual(bridge.matches, relay.matches);
});

test('manifest.json requires Chrome 150+ (the WebMCP-shipping version)', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.minimum_chrome_version, '150');
});

test('manifest.json does not request web_accessible_resources (none needed)', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('manifest.json does not request host_permissions (content_scripts.matches scopes injection; nothing uses the grant)', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.host_permissions, undefined);
});

test('every file referenced by manifest.json exists on disk', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const repoRoot = path.join(here, '..');
  const referenced = [
    manifest.devtools_page,
    manifest.background && manifest.background.service_worker,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...(manifest.icons ? Object.values(manifest.icons) : []),
  ].filter(Boolean);

  assert.ok(referenced.length > 0);
  for (const relativePath of referenced) {
    const fullPath = path.join(repoRoot, relativePath);
    assert.doesNotThrow(() => readFileSync(fullPath), `expected manifest-referenced file to exist: ${relativePath}`);
  }
});
