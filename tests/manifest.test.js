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

test('manifest.json registers content.js as an all_frames, document_start content script', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
  const [entry] = manifest.content_scripts;
  assert.deepEqual(entry.js, ['content.js']);
  assert.equal(entry.all_frames, true);
  assert.equal(entry.run_at, 'document_start');
  assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0);
});

test('manifest.json requires Chrome 150+ (the WebMCP-shipping version)', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.minimum_chrome_version, '150');
});

test('manifest.json does not request web_accessible_resources (none needed)', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.web_accessible_resources, undefined);
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
