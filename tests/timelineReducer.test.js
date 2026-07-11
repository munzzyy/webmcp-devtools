import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineState, timelineReducer, DEFAULT_TIMELINE_CAP } from '../core/timelineReducer.js';

test('createTimelineState starts empty with the given cap', () => {
  const state = createTimelineState(10);
  assert.deepEqual(state.entries, []);
  assert.equal(state.cap, 10);
});

test('createTimelineState falls back to DEFAULT_TIMELINE_CAP for an invalid cap', () => {
  assert.equal(createTimelineState(0).cap, DEFAULT_TIMELINE_CAP);
  assert.equal(createTimelineState(-5).cap, DEFAULT_TIMELINE_CAP);
  assert.equal(createTimelineState('nope').cap, DEFAULT_TIMELINE_CAP);
  assert.equal(createTimelineState().cap, DEFAULT_TIMELINE_CAP);
});

test('timelineReducer appends newest-first', () => {
  let state = createTimelineState(10);
  state = timelineReducer(state, { type: 'call', toolName: 'first', timestamp: 1 });
  state = timelineReducer(state, { type: 'call', toolName: 'second', timestamp: 2 });

  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].toolName, 'second'); // newest first
  assert.equal(state.entries[1].toolName, 'first');
});

test('timelineReducer accepts both "call" and "toolchange" event types', () => {
  let state = createTimelineState(10);
  state = timelineReducer(state, { type: 'toolchange', origin: 'https://example.com', timestamp: 1 });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].type, 'toolchange');
});

test('timelineReducer ignores unknown event types instead of throwing', () => {
  let state = createTimelineState(10);
  state = timelineReducer(state, { type: 'call', toolName: 'a', timestamp: 1 });
  const before = state;
  state = timelineReducer(state, { type: 'not-a-real-type' });
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.entries, before.entries);
});

test('timelineReducer tolerates malformed/missing events without throwing', () => {
  const state = createTimelineState(10);
  assert.doesNotThrow(() => timelineReducer(state, null));
  assert.doesNotThrow(() => timelineReducer(state, undefined));
  assert.doesNotThrow(() => timelineReducer(state, {}));
  assert.doesNotThrow(() => timelineReducer(undefined, { type: 'call' }));
});

test('timelineReducer "clear" empties entries but keeps the cap', () => {
  let state = createTimelineState(5);
  state = timelineReducer(state, { type: 'call', toolName: 'a', timestamp: 1 });
  state = timelineReducer(state, { type: 'clear' });
  assert.deepEqual(state.entries, []);
  assert.equal(state.cap, 5);
});

test('timelineReducer caps the entry count, dropping the oldest first', () => {
  let state = createTimelineState(3);
  for (let i = 0; i < 5; i += 1) {
    state = timelineReducer(state, { type: 'call', toolName: `call-${i}`, timestamp: i });
  }
  assert.equal(state.entries.length, 3);
  // newest-first: call-4, call-3, call-2 survive; call-0 and call-1 were dropped
  assert.deepEqual(
    state.entries.map((e) => e.toolName),
    ['call-4', 'call-3', 'call-2'],
  );
});

test('timelineReducer does not mutate the input state (pure function)', () => {
  const state = createTimelineState(10);
  const snapshotEntries = state.entries;
  timelineReducer(state, { type: 'call', toolName: 'a', timestamp: 1 });
  assert.equal(state.entries, snapshotEntries);
  assert.equal(state.entries.length, 0);
});

test('timelineReducer assigns a fallback id when the event has none, without crashing', () => {
  let state = createTimelineState(10);
  state = timelineReducer(state, { type: 'call', toolName: 'a', timestamp: 1 });
  assert.ok(state.entries[0].id, 'expected a fallback id to be assigned');
});

test('timelineReducer preserves an explicit id rather than overwriting it', () => {
  let state = createTimelineState(10);
  state = timelineReducer(state, { type: 'call', id: 'call-42', toolName: 'a', timestamp: 1 });
  assert.equal(state.entries[0].id, 'call-42');
});
