import test from 'node:test';
import assert from 'node:assert/strict';
import { worstSeverity, bySeverityDesc, SEVERITY_ORDER } from '../core/worstSeverity.js';

test('worstSeverity returns null for no findings', () => {
  assert.equal(worstSeverity([]), null);
  assert.equal(worstSeverity(undefined), null);
  assert.equal(worstSeverity(null), null);
});

test('worstSeverity picks critical over everything else, regardless of array order', () => {
  assert.equal(
    worstSeverity([{ severity: 'low' }, { severity: 'critical' }, { severity: 'info' }]),
    'critical',
  );
  assert.equal(worstSeverity([{ severity: 'critical' }, { severity: 'high' }]), 'critical');
});

test('worstSeverity respects the full ranking: critical > high > medium > low > info', () => {
  for (let i = 0; i < SEVERITY_ORDER.length; i += 1) {
    const worseSeverities = SEVERITY_ORDER.slice(i);
    const findings = worseSeverities.map((severity) => ({ severity }));
    assert.equal(worstSeverity(findings), SEVERITY_ORDER[i]);
  }
});

test('worstSeverity treats a missing/malformed severity as info, never throws', () => {
  assert.equal(worstSeverity([{ title: 'no severity field' }]), 'info');
  assert.equal(worstSeverity([{ severity: 42 }]), 'info');
  assert.equal(worstSeverity([null, undefined, { severity: 'high' }]), 'high');
});

test('worstSeverity keeps an unrecognized severity string (never drops findings) but ranks it last', () => {
  const worst = worstSeverity([{ severity: 'made-up' }]);
  assert.equal(worst, 'made-up');
  // ...but it should never outrank a real known severity
  assert.equal(worstSeverity([{ severity: 'made-up' }, { severity: 'low' }]), 'low');
});

test('bySeverityDesc sorts worst-first', () => {
  const findings = [{ severity: 'low' }, { severity: 'critical' }, { severity: 'medium' }, { severity: 'info' }];
  const sorted = [...findings].sort(bySeverityDesc).map((f) => f.severity);
  assert.deepEqual(sorted, ['critical', 'medium', 'low', 'info']);
});

test('bySeverityDesc places unrecognized/missing severities last, stably relative to each other', () => {
  const findings = [{ severity: 'critical' }, {}, { severity: 'weird' }, { severity: 'low' }];
  const sorted = [...findings].sort(bySeverityDesc);
  assert.equal(sorted[0].severity, 'critical');
  assert.equal(sorted[1].severity, 'low');
});
