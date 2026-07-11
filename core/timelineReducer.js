// core/timelineReducer.js
//
// Pure reducer for the panel's call-history timeline. No chrome.* dependency.
// Newest entries first (unshift, not push), capped so a chatty page can't
// grow the panel's memory without bound. panel.js owns turning `TimelineState`
// into DOM; this file only owns the append/cap/clear logic so it can be
// unit-tested without a browser.

export const DEFAULT_TIMELINE_CAP = 500;

/**
 * @typedef {{ entries: Array<Record<string, unknown>>, cap: number }} TimelineState
 */

/**
 * @param {number} [cap]
 * @returns {TimelineState}
 */
export function createTimelineState(cap = DEFAULT_TIMELINE_CAP) {
  return { entries: [], cap: normalizeCap(cap) };
}

/**
 * @param {TimelineState} state
 * @param {{ type: 'call' | 'toolchange' | 'clear', [key: string]: unknown }} event
 * @returns {TimelineState} a new state; the input state is never mutated
 */
export function timelineReducer(state, event) {
  const entries = state && Array.isArray(state.entries) ? state.entries : [];
  const cap = normalizeCap(state && state.cap);

  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return { entries, cap };
  }

  if (event.type === 'clear') {
    return { entries: [], cap };
  }

  if (event.type !== 'call' && event.type !== 'toolchange') {
    return { entries, cap }; // unknown event types are ignored, never thrown
  }

  const entry = { ...event, id: event.id ?? fallbackId(entries, event) };
  const next = [entry, ...entries];
  return { entries: next.length > cap ? next.slice(0, cap) : next, cap };
}

function normalizeCap(cap) {
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_TIMELINE_CAP;
}

// Deterministic fallback id derived purely from the inputs (no module-level
// mutable counters, no Math.random) so the reducer stays a pure function.
function fallbackId(existingEntries, event) {
  const ts = typeof event.timestamp === 'number' ? event.timestamp : 0;
  return `fallback-${existingEntries.length}-${ts}`;
}
