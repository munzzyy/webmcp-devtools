#!/usr/bin/env node
// tools/demo-lint.js
//
// A five-second, zero-install look at what lint.js catches: no Chrome, no
// unpacked extension, just Node running the same pure linting logic the
// panel uses, against the same 4 sample tools examples/demo.html registers
// (examples/demo-tools.js is the shared source for both).
//
//   node tools/demo-lint.js

import { normalizeTool } from '../core/normalizeTool.js';
import { lintTool } from '../lint.js';
import { demoTools } from '../examples/demo-tools.js';

// Matches lint.test.js's own worst-to-best ordering.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function bySeverity(findings) {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

function tag(severity) {
  const label = severity.toUpperCase();
  const pad = Math.max(0, 8 - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + label + ' '.repeat(right);
}

console.log(`\n  webmcp-devtools demo-lint  (examples/demo.html sample tools)`);
console.log(`  ${demoTools.length} tool(s) scanned\n`);

let totalFindings = 0;
let flaggedTools = 0;

for (const raw of demoTools) {
  const tool = normalizeTool(raw);
  const findings = bySeverity(lintTool(tool));
  totalFindings += findings.length;
  if (findings.length > 0) flaggedTools += 1;

  console.log(`  ${tool.name}`);
  if (findings.length === 0) {
    console.log('    no findings\n');
    continue;
  }
  for (const f of findings) {
    console.log(`     ${tag(f.severity)}  ${f.title}  [${f.id}]`);
    console.log(`           ${f.detail}`);
  }
  console.log('');
}

console.log(
  `  ${demoTools.length - flaggedTools} tool(s) clean, ${flaggedTools} tool(s) flagged, ` +
    `${totalFindings} finding(s) total\n`,
);

process.exitCode = totalFindings > 0 ? 1 : 0;
