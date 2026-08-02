// core/toolDiff.js
//
// Pure diffing for successive tool announcements from one frame. No chrome.*
// dependency. This is the mid-session tool-injection (MSTI) detector: a live
// panel is the one place that can see a tool's description, hints, or schema
// change AFTER the tool was first announced -- the exact move that re-frames
// an already-reviewed tool for the agent while the human looks away. Static
// linting cannot catch it; a diff across announcements can.
//
// Tools are matched by the stable toolId content.js/page-bridge.js assign
// (live-object identity, not position), so "same id, different fields" really
// means the page mutated a registered tool in place.

const COMPARED_FIELDS = ['name', 'description', 'readOnlyHint', 'untrustedContentHint', 'inputSchema'];

/**
 * A stable fingerprint of everything the agent sees about a tool. Two tools
 * with the same fingerprint are, from the agent's point of view, the same
 * definition. Never throws: hostile schemas degrade to a lossy string.
 * @param {ReturnType<import('./normalizeTool.js').normalizeTool>} tool
 * @returns {string}
 */
export function toolFingerprint(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const annotations = t.annotations && typeof t.annotations === 'object' ? t.annotations : {};
  return lossyJson([
    typeof t.name === 'string' ? t.name : '',
    typeof t.description === 'string' ? t.description : '',
    annotations.readOnlyHint === true,
    annotations.untrustedContentHint === true,
    lossyJson(t.inputSchema),
  ]);
}

/**
 * Diffs two normalized tool lists by toolId.
 * @param {Array} prevTools
 * @param {Array} nextTools
 * @returns {{
 *   added: Array<{toolId: string|null, name: string}>,
 *   removed: Array<{toolId: string|null, name: string}>,
 *   mutated: Array<{toolId: string, name: string, fields: string[]}>,
 * }}
 */
export function diffToolLists(prevTools, nextTools) {
  const prev = Array.isArray(prevTools) ? prevTools : [];
  const next = Array.isArray(nextTools) ? nextTools : [];
  const added = [];
  const removed = [];
  const mutated = [];

  const prevById = new Map();
  for (const tool of prev) {
    if (tool && typeof tool.toolId === 'string') prevById.set(tool.toolId, tool);
  }

  const seen = new Set();
  for (const tool of next) {
    if (!tool || typeof tool !== 'object') continue;
    const id = typeof tool.toolId === 'string' ? tool.toolId : null;
    const before = id !== null ? prevById.get(id) : undefined;
    if (before === undefined) {
      added.push({ toolId: id, name: nameOf(tool) });
      continue;
    }
    seen.add(id);
    const fields = changedFields(before, tool);
    if (fields.length > 0) mutated.push({ toolId: id, name: nameOf(tool), fields });
  }

  for (const [id, tool] of prevById) {
    if (!seen.has(id)) removed.push({ toolId: id, name: nameOf(tool) });
  }
  // Tools without a stable toolId (only possible in hand-built input; real
  // announcements always carry one) are matched as added-only, never removed.

  return { added, removed, mutated };
}

function changedFields(before, after) {
  const fields = [];
  for (const field of COMPARED_FIELDS) {
    if (field === 'readOnlyHint' || field === 'untrustedContentHint') {
      const a = before.annotations && before.annotations[field] === true;
      const b = after.annotations && after.annotations[field] === true;
      if (a !== b) fields.push(field);
    } else if (field === 'inputSchema') {
      if (lossyJson(before.inputSchema) !== lossyJson(after.inputSchema)) fields.push(field);
    } else if ((before[field] ?? '') !== (after[field] ?? '')) {
      fields.push(field);
    }
  }
  return fields;
}

function nameOf(tool) {
  return tool && typeof tool.name === 'string' ? tool.name : '(unnamed tool)';
}

// Cycle- and BigInt-proof stringify: page-controlled schemas must never make
// the differ throw (that failure mode is what lint.js just got fixed for).
function lossyJson(value) {
  try {
    const seen = new WeakSet();
    return String(JSON.stringify(value, (key, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'function') return '[Function]';
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }));
  } catch (err) {
    return '[unserializable]';
  }
}
