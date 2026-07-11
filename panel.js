// panel.js
//
// The "WebMCP" DevTools panel UI. Runs as a regular extension page (loaded
// by devtools.js via chrome.devtools.panels.create), so it can freely
// `import` the pure core/ modules and lint.js like any other ES module --
// no web_accessible_resources needed, since that requirement only applies to
// content-script module imports or a web page reaching into the extension,
// neither of which is happening here.
//
// SECURITY: tool names/descriptions/schemas/annotations and lint finding
// text all originate from an arbitrary, untrusted web page. This file NEVER
// uses innerHTML and NEVER evals any of it. Every page-derived string is
// rendered exclusively through the `h()` helper below, which only ever
// assigns to `.textContent` / uses `document.createTextNode` -- both of
// which treat their input as literal text, never as markup. That is the one
// enforcement point for the "no XSS from a hostile tool description" rule
// this whole file depends on.

import { normalizeTool } from './core/normalizeTool.js';
import { worstSeverity, bySeverityDesc } from './core/worstSeverity.js';
import { createTimelineState, timelineReducer } from './core/timelineReducer.js';
import { lintTool } from './lint.js';

const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: 'webmcp-panel' });

/** @type {Map<number, { origin: string, hasModelContext: boolean, tools: ReturnType<typeof normalizeTool>[] }>} */
const toolsByFrame = new Map();
let timelineState = createTimelineState();
let selectedToolKey = null; // { frameId, name } | null
let callCounter = 0;

// Match the DevTools theme (chrome.devtools.panels.themeName is 'default' or
// 'dark') so severity colors keep their contrast ratio in either theme;
// panel.css defines both palettes.
const theme = typeof chrome.devtools.panels.themeName === 'string' ? chrome.devtools.panels.themeName : 'default';
document.body.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');

port.onMessage.addListener(handleMessage);
port.postMessage({ type: 'init', tabId });
port.postMessage({ type: 'getTools' }); // fetch current state immediately; content.js may have
// already self-announced before this panel existed, so ask fresh rather than waiting.

document.getElementById('refresh-btn').addEventListener('click', () => {
  port.postMessage({ type: 'getTools' });
});

document.getElementById('clear-timeline-btn').addEventListener('click', () => {
  timelineState = timelineReducer(timelineState, { type: 'clear' });
  renderTimeline();
});

document.getElementById('execute-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedToolKey) return;

  const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('execute-args'));
  const errorEl = document.getElementById('execute-error');
  errorEl.textContent = '';

  const raw = textarea.value.trim() === '' ? '{}' : textarea.value;
  try {
    JSON.parse(raw); // validate only -- the ORIGINAL text is forwarded as the JSON-string arg
  } catch (err) {
    errorEl.textContent = `Arguments must be valid JSON: ${err.message}`;
    return;
  }

  callCounter += 1;
  const callId = `call-${Date.now()}-${callCounter}`;
  port.postMessage({
    type: 'executeTool',
    frameId: selectedToolKey.frameId,
    toolName: selectedToolKey.name,
    argsJson: raw,
    callId,
  });
});

renderStatusBar();
renderToolsTable();
renderTimeline();

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'status':
      upsertFrameStatus(msg);
      renderStatusBar();
      break;
    case 'tools':
      upsertFrameTools(msg);
      renderStatusBar();
      renderToolsTable();
      renderDetail();
      break;
    case 'toolchange':
      timelineState = timelineReducer(timelineState, {
        type: 'toolchange',
        frameId: msg.frameId,
        origin: msg.origin,
        timestamp: msg.timestamp,
      });
      renderTimeline();
      break;
    case 'executeResult':
      handleExecuteResult(msg);
      break;
    default:
      break; // unrecognized message shape; ignore rather than throw
  }
}

function upsertFrameStatus(msg) {
  const existing = toolsByFrame.get(msg.frameId) || { tools: [] };
  toolsByFrame.set(msg.frameId, {
    tools: existing.tools,
    origin: typeof msg.origin === 'string' ? msg.origin : existing.origin || '',
    hasModelContext: !!msg.hasModelContext,
  });
}

function upsertFrameTools(msg) {
  const rawTools = Array.isArray(msg.tools) ? msg.tools : [];
  toolsByFrame.set(msg.frameId, {
    origin: typeof msg.origin === 'string' ? msg.origin : '',
    hasModelContext: msg.hasModelContext !== false,
    tools: rawTools.map(normalizeTool),
  });
}

function handleExecuteResult(msg) {
  timelineState = timelineReducer(timelineState, {
    type: 'call',
    frameId: msg.frameId,
    callId: msg.callId,
    toolName: msg.toolName,
    argsJson: msg.argsJson,
    ok: msg.ok,
    result: msg.result,
    error: msg.error,
    timestamp: msg.timestamp,
  });
  renderTimeline();

  if (selectedToolKey && selectedToolKey.frameId === msg.frameId && selectedToolKey.name === msg.toolName) {
    const resultEl = document.getElementById('execute-result');
    resultEl.textContent = msg.ok ? safeStringify(msg.result) : `Error: ${msg.error}`;
  }
}

// ---------------------------------------------------------------------------
// DOM helper -- the ONLY place page-derived strings become DOM nodes.
// ---------------------------------------------------------------------------

/**
 * Builds a DOM element. `props.text`, and every plain-string child, are
 * assigned via textContent/createTextNode -- never innerHTML -- so a hostile
 * tool name/description/finding string can never be parsed as markup.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {Array<Node | string>} [children]
 */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatusBar() {
  const statusEl = document.getElementById('status-bar');
  clear(statusEl);

  const frames = [...toolsByFrame.values()];
  if (frames.length === 0) {
    statusEl.appendChild(h('span', { class: 'status-badge status-pending', text: 'Waiting for page…' }));
    return;
  }

  const anyModelContext = frames.some((f) => f.hasModelContext);
  const totalTools = frames.reduce((sum, f) => sum + f.tools.length, 0);

  if (!anyModelContext) {
    statusEl.appendChild(
      h('span', { class: 'status-badge status-absent', text: 'document.modelContext: not found' }),
    );
    statusEl.appendChild(
      h('p', {
        class: 'empty-state',
        text:
          'No WebMCP tools found on this page. Enable chrome://flags/#enable-webmcp-testing, ' +
          'or the page must register tools / load the polyfill (@mcp-b/webmcp-polyfill).',
      }),
    );
    return;
  }

  const frameWord = frames.length === 1 ? 'frame' : 'frames';
  const toolWord = totalTools === 1 ? 'tool' : 'tools';
  statusEl.appendChild(
    h('span', {
      class: 'status-badge status-present',
      text: `document.modelContext: present (${totalTools} ${toolWord} across ${frames.length} ${frameWord})`,
    }),
  );
}

function flattenTools() {
  const rows = [];
  for (const [frameId, frame] of toolsByFrame) {
    for (const tool of frame.tools) {
      rows.push({ frameId, tool });
    }
  }
  rows.sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  return rows;
}

function safeLint(tool) {
  try {
    const findings = lintTool(tool);
    return Array.isArray(findings) ? findings : [];
  } catch (err) {
    // lint.js is a swappable module; a bug in it should never crash the panel.
    return [
      {
        id: 'lint-threw',
        severity: 'info',
        title: 'Diagnostics failed',
        detail: err && err.message ? String(err.message) : String(err),
      },
    ];
  }
}

function renderToolsTable() {
  const tbody = document.getElementById('tools-tbody');
  clear(tbody);

  const rows = flattenTools();
  document.getElementById('tools-count').textContent = `${rows.length} tool${rows.length === 1 ? '' : 's'}`;

  for (const { frameId, tool } of rows) {
    const findings = safeLint(tool);
    const worst = worstSeverity(findings);
    const isSelected = !!selectedToolKey && selectedToolKey.frameId === frameId && selectedToolKey.name === tool.name;

    const tr = h(
      'tr',
      { class: `tool-row${isSelected ? ' tool-row-selected' : ''}`, tabindex: '0' },
      [
        h('td', { text: tool.name }),
        h('td', { text: tool.origin || '' }),
        h('td', { text: tool.annotations.readOnlyHint ? 'yes' : 'no' }),
        h('td', { text: tool.annotations.untrustedContentHint ? 'yes' : 'no' }),
        h('td', {}, [severityBadge(worst)]),
      ],
    );
    tr.addEventListener('click', () => selectTool(frameId, tool.name));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTool(frameId, tool.name);
      }
    });
    tbody.appendChild(tr);
  }
}

function severityBadge(severity) {
  return h('span', {
    class: `badge badge-${severity || 'none'}`,
    text: severity || 'clean',
  });
}

function findTool(frameId, name) {
  const frame = toolsByFrame.get(frameId);
  if (!frame) return null;
  return frame.tools.find((t) => t.name === name) || null;
}

function selectTool(frameId, name) {
  selectedToolKey = { frameId, name };
  renderToolsTable();
  renderDetail();
}

function renderDetail() {
  const section = document.getElementById('detail-section');
  if (!selectedToolKey) {
    section.hidden = true;
    return;
  }

  const tool = findTool(selectedToolKey.frameId, selectedToolKey.name);
  if (!tool) {
    section.hidden = true;
    selectedToolKey = null;
    return;
  }

  section.hidden = false;
  document.getElementById('detail-name').textContent = tool.name;
  document.getElementById('detail-description').textContent = tool.description || '(no description)';

  const schemaText =
    safeStringify(tool.inputSchema) + (tool.inputSchemaError ? `\n\n(schema warning: ${tool.inputSchemaError})` : '');
  document.getElementById('detail-schema').textContent = schemaText;

  const findingsList = document.getElementById('detail-findings');
  clear(findingsList);
  const findings = [...safeLint(tool)].sort(bySeverityDesc);
  if (findings.length === 0) {
    findingsList.appendChild(h('li', { class: 'finding-none', text: 'No findings.' }));
  } else {
    for (const finding of findings) {
      const severity = finding && typeof finding.severity === 'string' ? finding.severity : 'info';
      const li = h('li', { class: `finding finding-${severity}` }, [
        h('span', { class: 'finding-severity', text: severity.toUpperCase() }),
        h('span', { class: 'finding-title', text: (finding && finding.title) || '(untitled finding)' }),
        h('p', { class: 'finding-detail', text: (finding && finding.detail) || '' }),
      ]);
      findingsList.appendChild(li);
    }
  }

  document.getElementById('execute-error').textContent = '';
  document.getElementById('execute-result').textContent = '';
}

function renderTimeline() {
  const list = document.getElementById('timeline-list');
  clear(list);
  for (const entry of timelineState.entries) {
    list.appendChild(renderTimelineEntry(entry));
  }
}

function renderTimelineEntry(entry) {
  const time = new Date(typeof entry.timestamp === 'number' ? entry.timestamp : Date.now()).toLocaleTimeString();

  if (entry.type === 'toolchange') {
    return h('li', { class: 'timeline-item timeline-toolchange' }, [
      h('span', { class: 'timeline-time', text: time }),
      h('span', { class: 'timeline-kind', text: 'toolchange' }),
      h('span', { class: 'timeline-origin', text: entry.origin || '' }),
    ]);
  }

  const statusText = entry.ok ? 'ok' : 'error';
  const li = h('li', { class: `timeline-item timeline-call timeline-${statusText}` }, [
    h('span', { class: 'timeline-time', text: time }),
    h('span', { class: 'timeline-kind', text: `call: ${entry.toolName || '(unknown)'}` }),
    h('span', { class: 'timeline-status', text: statusText }),
  ]);

  const bodyText = entry.ok
    ? `args:   ${entry.argsJson || ''}\nresult: ${safeStringify(entry.result)}`
    : `args:   ${entry.argsJson || ''}\nerror:  ${entry.error || ''}`;

  li.appendChild(h('details', {}, [h('summary', { text: 'args / result' }), h('pre', { text: bodyText })]));
  return li;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (err) {
    return String(value);
  }
}
