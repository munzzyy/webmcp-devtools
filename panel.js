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
import { diffToolLists, toolFingerprint } from './core/toolDiff.js';
import { lintTool } from './lint.js';

const tabId = chrome.devtools.inspectedWindow.tabId;

/** @type {Map<number, { origin: string, hasModelContext: boolean, bridge?: boolean, surfaces?: object, capabilities?: object, observing?: object, error?: string, announcedTools?: boolean, tools: ReturnType<typeof normalizeTool>[] }>} */
const toolsByFrame = new Map();
// frameId:toolId -> Set of field names the page changed after registration
const mutatedFields = new Map();
let timelineState = createTimelineState();
let selectedToolKey = null; // { frameId, toolId, fingerprint } | null
let lastDetailKey = null; // which selection the execute result panes belong to
let callCounter = 0;

// Match the DevTools theme (chrome.devtools.panels.themeName is 'default' or
// 'dark') so severity colors keep their contrast ratio in either theme;
// panel.css defines both palettes.
const theme = typeof chrome.devtools.panels.themeName === 'string' ? chrome.devtools.panels.themeName : 'default';
document.body.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');

// An MV3 service-worker cycle (extension reload/update, worker crash, the
// chrome://extensions toggle) silently closes the Port. A panel that keeps
// rendering its last tool list after that is the worst failure mode a
// security tool can have: a stale clean verdict looks identical to a fresh
// one. So on disconnect the tools are dropped, the status bar says so, and
// the panel reconnects with capped backoff.
let port = null;
let disconnected = false;
let reconnectDelay = 250;
const RECONNECT_MAX_MS = 5000;

function connect() {
  let p;
  try {
    p = chrome.runtime.connect({ name: 'webmcp-panel' });
  } catch (err) {
    disconnected = true;
    renderStatusBar();
    return;
  }
  port = p;
  disconnected = false;
  p.onMessage.addListener(handleMessage);
  p.postMessage({ type: 'init', tabId });
  p.postMessage({ type: 'getTools' }); // fetch current state immediately; the content side may
  // have already self-announced before this panel existed, so ask fresh rather than waiting.
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    port = null;
    disconnected = true;
    toolsByFrame.clear();
    mutatedFields.clear();
    renderStatusBar();
    renderToolsTable();
    renderDetail();
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setTimeout(connect, delay);
  });
}

function send(msg) {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (err) {
    // port died between the check and the send; onDisconnect handles it
  }
}

connect();

document.getElementById('refresh-btn').addEventListener('click', () => {
  send({ type: 'getTools' });
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

  const selected = findTool(selectedToolKey.frameId, selectedToolKey.toolId);
  if (!selected) return;

  // Never execute a tool that no longer matches what was reviewed. The
  // toolset diff normally clears the selection first; this is the backstop.
  if (selectedToolKey.fingerprint && toolFingerprint(selected) !== selectedToolKey.fingerprint) {
    errorEl.textContent = 'This tool changed since you selected it. Re-select it and review the current definition before executing.';
    return;
  }

  const raw = textarea.value.trim() === '' ? '{}' : textarea.value;
  try {
    JSON.parse(raw); // validate only -- the ORIGINAL text is forwarded; the bridge parses it
  } catch (err) {
    errorEl.textContent = `Arguments must be valid JSON: ${err.message}`;
    return;
  }

  callCounter += 1;
  const callId = `call-${Date.now()}-${callCounter}`;
  send({
    type: 'executeTool',
    frameId: selectedToolKey.frameId,
    toolId: selectedToolKey.toolId,
    toolName: selected.name, // display only; the bridge resolves the tool by toolId
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
      // A 'status' with hasModelContext:false (e.g. after navigating to a page
      // with no WebMCP) drops that frame's tools, so the table and detail pane
      // must re-render too or they keep showing the previous page's tools.
      renderToolsTable();
      renderDetail();
      break;
    case 'tools':
      upsertFrameTools(msg);
      renderStatusBar();
      renderToolsTable();
      renderDetail();
      break;
    case 'frameGone':
      clearFrameMutations(msg.frameId);
      if (toolsByFrame.delete(msg.frameId)) {
        renderStatusBar();
        renderToolsTable();
        renderDetail();
      }
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
    case 'observedCall':
      // A call the page (or an agent driving it) made itself, seen through the
      // bridge's executeTool/handler wrappers -- not one this panel issued.
      timelineState = timelineReducer(timelineState, {
        type: 'call',
        initiator: 'page',
        frameId: msg.frameId,
        toolName: msg.toolName,
        argsJson: msg.argsJson,
        ok: msg.ok,
        result: msg.result,
        error: msg.error,
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
  const hasModelContext = !!msg.hasModelContext;
  if (!hasModelContext) clearFrameMutations(msg.frameId);
  toolsByFrame.set(msg.frameId, {
    // When the frame no longer has a modelContext, its tools are gone -- keeping
    // them would leave the previous page's tools listed and lintable under a
    // "not found" status bar. Only carry tools forward while it still has one.
    tools: hasModelContext ? existing.tools : [],
    announcedTools: hasModelContext ? existing.announcedTools : false,
    origin: typeof msg.origin === 'string' ? msg.origin : existing.origin || '',
    hasModelContext,
    // Bridge health and surface/capability detail from page-bridge.js.
    // content.js stamps bridge:true on live-bridge statuses and sends an
    // explicit bridge:false when the bridge never checked in.
    bridge: typeof msg.bridge === 'boolean' ? msg.bridge : existing.bridge,
    surfaces: msg.surfaces && typeof msg.surfaces === 'object' ? msg.surfaces : existing.surfaces,
    capabilities: msg.capabilities && typeof msg.capabilities === 'object' ? msg.capabilities : existing.capabilities,
    observing: msg.observing && typeof msg.observing === 'object' ? msg.observing : existing.observing,
  });
}

function upsertFrameTools(msg) {
  const existing = toolsByFrame.get(msg.frameId);
  const rawTools = Array.isArray(msg.tools) ? msg.tools : [];
  const hasModelContext = msg.hasModelContext !== false;
  const origin = typeof msg.origin === 'string' ? msg.origin : '';
  const nextTools = rawTools.map(normalizeTool);

  // Diff against the previous announcement from this frame. A tool whose
  // description, hints, or schema change AFTER it was first announced is the
  // mid-session move a static lint can never see; record what changed, both
  // in the timeline and as a per-tool finding.
  if (existing && existing.announcedTools && hasModelContext) {
    const diff = diffToolLists(existing.tools, nextTools);
    if (diff.added.length || diff.removed.length || diff.mutated.length) {
      timelineState = timelineReducer(timelineState, {
        type: 'toolset',
        frameId: msg.frameId,
        origin,
        timestamp: Date.now(),
        added: diff.added.map((t) => t.name),
        removed: diff.removed.map((t) => t.name),
        mutated: diff.mutated,
      });
      renderTimeline();
      for (const m of diff.mutated) {
        const key = `${msg.frameId}:${m.toolId}`;
        const fields = mutatedFields.get(key) || new Set();
        for (const field of m.fields) fields.add(field);
        mutatedFields.set(key, fields);
      }
      for (const r of diff.removed) mutatedFields.delete(`${msg.frameId}:${r.toolId}`);
    }
  }
  if (!hasModelContext) clearFrameMutations(msg.frameId);

  toolsByFrame.set(msg.frameId, {
    origin,
    hasModelContext,
    announcedTools: hasModelContext,
    // The bridge sets `error` when getTools() rejected or returned a non-array.
    // Keep it so the status bar can say so instead of showing "present (0 tools)".
    error: typeof msg.error === 'string' ? msg.error : undefined,
    tools: nextTools,
    bridge: existing ? existing.bridge : undefined,
    surfaces: existing ? existing.surfaces : undefined,
    capabilities: existing ? existing.capabilities : undefined,
    observing: existing ? existing.observing : undefined,
  });
}

function clearFrameMutations(frameId) {
  const prefix = `${frameId}:`;
  for (const key of [...mutatedFields.keys()]) {
    if (key.startsWith(prefix)) mutatedFields.delete(key);
  }
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

  if (selectedToolKey && selectedToolKey.frameId === msg.frameId && selectedToolKey.toolId === msg.toolId) {
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

  // A dropped Port means everything below is unknown, not clean. Say so and
  // keep saying so until the reconnect lands and fresh state arrives.
  if (disconnected) {
    statusEl.appendChild(
      h('span', {
        class: 'status-badge status-error',
        text: 'Disconnected from the extension (service worker restarted?). Reconnecting; tool state is unknown until then.',
      }),
    );
    return;
  }

  const frames = [...toolsByFrame.values()];
  if (frames.length === 0) {
    statusEl.appendChild(h('span', { class: 'status-badge status-pending', text: 'Waiting for page…' }));
    return;
  }

  // A frame whose MAIN-world bridge never checked in cannot be inspected at
  // all. That is a "diagnostics did not run" state, never a clean verdict --
  // render it as an error, and never let it fall through to "not found".
  const deadBridges = frames.filter((f) => f.bridge === false);
  for (const f of deadBridges) {
    statusEl.appendChild(
      h('span', {
        class: 'status-badge status-error',
        text: `Bridge did not run${f.origin ? ` in ${f.origin}` : ''}: this frame cannot be inspected. Do not read it as having no tools.`,
      }),
    );
  }

  const liveFrames = frames.filter((f) => f.bridge !== false);
  const anyModelContext = liveFrames.some((f) => f.hasModelContext);
  const totalTools = liveFrames.reduce((sum, f) => sum + f.tools.length, 0);

  // The spec moved the API from navigator to document mid-origin-trial, so
  // pages written against Chrome 149 may register tools only on the old
  // surface. Those tools are invisible here (this panel reads
  // document.modelContext, the current surface) and the page breaks when the
  // origin trial ends -- both worth telling the user about explicitly.
  const navOnly = liveFrames.filter((f) => f.surfaces && f.surfaces.navigator && !f.surfaces.document);
  for (const f of navOnly) {
    statusEl.appendChild(
      h('span', {
        class: 'status-badge status-warn',
        text: `navigator.modelContext only${f.origin ? ` in ${f.origin}` : ''}: deprecated surface, not readable here, and it stops working when the origin trial ends.`,
      }),
    );
  }

  if (!anyModelContext) {
    if (liveFrames.length > 0) {
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
    }
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

  // "Present" with no getTools() is a real state (the explainer specifies
  // registerTool first and leaves discovery as a TODO): the list below is
  // then only what the bridge observed registering, not a full enumeration.
  const noGetTools = liveFrames.filter(
    (f) => f.hasModelContext && f.capabilities && f.capabilities.getTools === false,
  );
  for (const f of noGetTools) {
    statusEl.appendChild(
      h('span', {
        class: 'status-badge status-warn',
        text: `getTools() unavailable${f.origin ? ` in ${f.origin}` : ''}: showing only registrations observed since the bridge loaded, not a full listing.`,
      }),
    );
  }

  // A frame that reported an error reading its tools would otherwise be
  // indistinguishable from a frame that genuinely has zero -- surface it so
  // "present (0 tools)" is never mistaken for "tools read successfully".
  const errored = frames.filter((f) => typeof f.error === 'string' && f.error);
  for (const f of errored) {
    statusEl.appendChild(
      h('span', { class: 'status-badge status-error', text: `Error reading tools: ${f.error}` }),
    );
  }
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

// Memoize per tool object. renderToolsTable lints every row and renderDetail
// lints the selected one again, and both re-run on every 'tools'/'toolchange'
// message -- all of which a page can fire in a loop. A new 'tools' message
// rebuilds the normalized tool objects, so this WeakMap naturally recomputes
// then and only then; within one render pass each tool is linted once.
const lintCache = new WeakMap();

function safeLint(tool) {
  if (tool && typeof tool === 'object' && lintCache.has(tool)) {
    return lintCache.get(tool);
  }
  try {
    const findings = lintTool(tool);
    const out = Array.isArray(findings) ? findings : [];
    if (tool && typeof tool === 'object') lintCache.set(tool, out);
    return out;
  } catch (err) {
    // lint.js is a swappable module; a bug in it should never crash the panel.
    // But a lint pass that died on page-controlled input must never read as
    // safer than a clean tool -- the input that killed the linter is exactly
    // the input that deserves suspicion. Report loudly, at high severity.
    return [
      {
        id: 'lint-threw',
        severity: 'high',
        title: 'Diagnostics did not run',
        detail: `The linter threw on this tool (${err && err.message ? String(err.message) : String(err)}). Treat it as unreviewed, not as clean.`,
      },
    ];
  }
}

// The static lint findings, plus the dynamic one only a live panel can make:
// whether the page changed this tool's definition after it was first
// announced. Mutating an already-reviewed description, hint, or schema is a
// known re-framing move against agents (and against the human who reviewed
// the original), so it grades high; a name or untrusted-content-hint change
// still warrants a look.
function findingsFor(frameId, tool) {
  const findings = safeLint(tool);
  const fieldSet = tool && typeof tool.toolId === 'string' ? mutatedFields.get(`${frameId}:${tool.toolId}`) : undefined;
  if (!fieldSet || fieldSet.size === 0) return findings;
  const fields = [...fieldSet].sort();
  const highRisk = fields.some((f) => f === 'description' || f === 'readOnlyHint' || f === 'inputSchema');
  return [
    ...findings,
    {
      id: 'mutated-after-registration',
      severity: highRisk ? 'high' : 'medium',
      title: `Tool definition changed after registration (${fields.join(', ')})`,
      detail:
        `The page changed this tool's ${fields.join(', ')} after it was first announced. ` +
        'Re-framing a tool mid-session is how a page gets a reviewed-and-trusted tool to do something else. ' +
        'Re-read the current definition before trusting or executing it.',
    },
  ];
}

function renderToolsTable() {
  const tbody = document.getElementById('tools-tbody');
  clear(tbody);

  const rows = flattenTools();
  document.getElementById('tools-count').textContent = `${rows.length} tool${rows.length === 1 ? '' : 's'}`;

  for (const { frameId, tool } of rows) {
    const findings = findingsFor(frameId, tool);
    const worst = worstSeverity(findings);
    const isSelected = !!selectedToolKey && selectedToolKey.frameId === frameId && selectedToolKey.toolId === tool.toolId;

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
    tr.addEventListener('click', () => selectTool(frameId, tool.toolId));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTool(frameId, tool.toolId);
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

function findTool(frameId, toolId) {
  const frame = toolsByFrame.get(frameId);
  if (!frame) return null;
  return frame.tools.find((t) => t.toolId === toolId) || null;
}

function selectTool(frameId, toolId) {
  // The fingerprint freezes what the user actually reviewed. If the page
  // mutates the tool afterward, the execute handler refuses to run it until
  // it is re-selected (and therefore re-read) in its current form.
  const tool = findTool(frameId, toolId);
  selectedToolKey = { frameId, toolId, fingerprint: tool ? toolFingerprint(tool) : null };
  renderToolsTable();
  renderDetail();
}

function renderDetail() {
  const section = document.getElementById('detail-section');
  if (!selectedToolKey) {
    section.hidden = true;
    lastDetailKey = null;
    return;
  }

  const tool = findTool(selectedToolKey.frameId, selectedToolKey.toolId);
  if (!tool) {
    section.hidden = true;
    selectedToolKey = null;
    lastDetailKey = null;
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
  const findings = [...findingsFor(selectedToolKey.frameId, tool)].sort(bySeverityDesc);
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

  // Only reset the execute panes when the selection itself changes. Clearing
  // them on every render pass let any page that fires toolchange in a loop
  // erase a result out from under the user -- including one they were about
  // to notice.
  const detailKey = `${selectedToolKey.frameId}:${selectedToolKey.toolId}`;
  if (lastDetailKey !== detailKey) {
    lastDetailKey = detailKey;
    document.getElementById('execute-error').textContent = '';
    document.getElementById('execute-result').textContent = '';
  }
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

  // What actually changed between two announcements: added / removed /
  // mutated tool names, and for mutations, which fields. All page-derived
  // strings, so everything renders through h() as text.
  if (entry.type === 'toolset') {
    const added = Array.isArray(entry.added) ? entry.added : [];
    const removed = Array.isArray(entry.removed) ? entry.removed : [];
    const mutated = Array.isArray(entry.mutated) ? entry.mutated : [];
    const parts = [];
    if (added.length) parts.push(`added: ${added.join(', ')}`);
    if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
    for (const m of mutated) {
      const fields = m && Array.isArray(m.fields) ? m.fields.join(', ') : '';
      parts.push(`changed: ${m && m.name ? m.name : '(unnamed tool)'} (${fields})`);
    }
    const li = h('li', { class: `timeline-item timeline-toolset${mutated.length ? ' timeline-mutation' : ''}` }, [
      h('span', { class: 'timeline-time', text: time }),
      h('span', { class: 'timeline-kind', text: 'tool set changed' }),
      h('span', { class: 'timeline-origin', text: entry.origin || '' }),
    ]);
    li.appendChild(h('pre', { class: 'timeline-diff', text: parts.join('\n') }));
    return li;
  }

  const observed = entry.initiator === 'page';
  const statusText = entry.ok ? 'ok' : 'error';
  const li = h('li', { class: `timeline-item timeline-call timeline-${statusText}` }, [
    h('span', { class: 'timeline-time', text: time }),
    h('span', {
      class: 'timeline-kind',
      text: `${observed ? 'observed call' : 'call'}: ${entry.toolName || '(unknown)'}`,
    }),
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
