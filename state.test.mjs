import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, normalizeState, youtubeId, sourceKind } from './state.mjs';

test('YouTube accepts live links and rejects channels and lookalike hosts', () => {
  for (const value of ['https://youtu.be/abcdefghijk?t=1', 'https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/live/abcdefghijk?si=x', 'abcdefghijk']) assert.equal(youtubeId(value), 'abcdefghijk');
  for (const value of ['https://youtube.com/@NBCNews/live', 'https://evil.com/watch?v=abcdefghijk', 'https://youtube.com.evil.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=bad']) assert.equal(youtubeId(value), null);
});

test('reducing the grid clears focus and audio for hidden streams', () => {
  const state = { ...initialState(), count: 6, focus: 5, audio: 5 };
  assert.equal(normalizeState(state).audio, 5);
  const smaller = normalizeState({ ...state, count: 4 });
  assert.equal(smaller.focus, null);
  assert.equal(smaller.audio, null);
});

test('invalid updates cannot replace working source settings', () => {
  assert.throws(() => normalizeState({ ...initialState(), count: 13 }));
  assert.throws(() => normalizeState({ ...initialState(), volume: 'invalid' }));
  const state = initialState();
  state.slots[0].type = 'youtube';
  state.slots[0].url = 'https://youtube.com/@NBCNews/live';
  assert.throws(() => normalizeState(state));
  state.slots[0] = { ...state.slots[0], type: 'video', url: 'javascript:alert(1)' };
  assert.throws(() => normalizeState(state));
});

test('all stream counts through twelve preserve the highest active source', () => {
  for (let count = 4; count <= 12; count++) {
    const state = normalizeState({ ...initialState(), count, focus: count - 1, audio: count - 1 });
    assert.equal(state.focus, count - 1);
    assert.equal(state.audio, count - 1);
    assert.equal(state.slots.length, 12);
  }
});

test('legacy six-source settings expand without losing existing URLs', () => {
  const state = initialState();
  state.slots = state.slots.slice(0, 6);
  state.slots[0].url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const expanded = normalizeState(state);
  assert.equal(expanded.slots.length, 12);
  assert.equal(expanded.slots[0].url, state.slots[0].url);
  assert.equal(expanded.slots[11].type, 'video');
});

test('auto video routes signed manifests and YouTube links to the right player', () => {
  const kind = url => sourceKind({ type: 'video', url });
  assert.equal(kind('https://example.com/live/stream.M3U8?token=x'), 'hls');
  assert.equal(kind('https://example.com/live/manifest.mpd?token=x'), 'dash');
  assert.equal(kind('https://example.com/movie.mp4'), 'video');
  assert.equal(kind('https://youtu.be/abcdefghijk'), 'youtube');
  assert.equal(sourceKind({ type: 'hls', url: 'https://example.com/live?token=x' }), 'hls');
});

test('direct source validation accepts stream URLs and rejects unsafe protocols', () => {
  for (const type of ['video', 'hls', 'dash']) {
    const state = initialState();
    state.slots[0] = { ...state.slots[0], type, url: 'https://example.com/live?token=abc' };
    assert.equal(normalizeState(state).slots[0].url, state.slots[0].url);
    for (const url of ['javascript:alert(1)', 'file:///secret', 'not a URL', 'rtsp://example.com/live']) {
      state.slots[0].url = url;
      assert.throws(() => normalizeState(state));
    }
  }
});

test('drawer visibility and TV commands survive saving without changing player sources', () => {
  const before = normalizeState(initialState());
  const after = normalizeState({ ...before, previews: false, playbackRequest: 1, fullscreenRequest: 2 });
  assert.equal(after.previews, false);
  assert.equal(after.playbackRequest, 1);
  assert.equal(after.fullscreenRequest, 2);
  assert.deepEqual(after.slots, before.slots);
  assert.equal(normalizeState(initialState()).previews, true);
});

test('YouTube settings open only for the focused YouTube source', () => {
  const state = initialState();
  state.slots[0].url = 'https://www.youtube.com/watch?v=abcdefghijk';
  state.focus = 0;
  state.youtubeSettings = 0;
  assert.equal(normalizeState(state).youtubeSettings, 0);
  state.focus = null;
  assert.equal(normalizeState(state).youtubeSettings, null);
  state.focus = 0;
  state.slots[0].type = 'hls';
  assert.equal(normalizeState(state).youtubeSettings, null);
});

test('saved stream order preserves source identities, focus and audio', () => {
  const before = normalizeState({ ...initialState(), count: 12, focus: 9, audio: 4 });
  const order = [9, 4, 0, 1, 2, 3, 5, 6, 7, 8, 10, 11];
  const after = normalizeState({ ...before, order });
  assert.deepEqual(after.order, order);
  assert.deepEqual(after.slots, before.slots);
  assert.equal(after.focus, 9);
  assert.equal(after.audio, 4);
  assert.deepEqual(normalizeState({ ...after, count: 4 }).order, order);
  const legacy = initialState();
  delete legacy.order;
  assert.deepEqual(normalizeState(legacy).order, initialState().order);
});

test('invalid orders cannot duplicate, remove or invent sources', () => {
  for (const order of [[], Array(12).fill(0), [...Array(11).keys(), 12], [...Array(11).keys(), '11']]) {
    assert.throws(() => normalizeState({ ...initialState(), order }), /Stream order/);
  }
});

test('removed capture and website types cannot be saved through the API', () => {
  for (const type of ['capture', 'server-browser', 'embed']) {
    const state = initialState();
    state.slots[0] = { ...state.slots[0], type, url: 'https://example.com/player' };
    assert.throws(() => normalizeState(state), /Unsupported source type/);
  }
  const state = initialState();
  state.slots[0].url = '<iframe src="https://example.com/player"></iframe>';
  assert.throws(() => normalizeState(state), /valid http/);
});

test('auto video accepts YouTube IDs and rejects non-web YouTube links', () => {
  const state = initialState();
  state.slots[0].url = 'abcdefghijk';
  assert.equal(sourceKind(normalizeState(state).slots[0]), 'youtube');
  for (const type of ['youtube', 'video']) {
    state.slots[0].type = type;
    state.slots[0].url = 'ftp://youtube.com/watch?v=abcdefghijk';
    assert.throws(() => normalizeState(state));
  }
});
