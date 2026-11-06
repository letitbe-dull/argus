import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { initialState, sourceKind } from './state.mjs';

function playback() {
  let source = readFileSync(new URL('app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
  source = source.slice(0, source.lastIndexOf('\nif (display) {'));
  const context = vm.createContext({ document: { body: { dataset: { mode: 'display' } }, addEventListener() {} }, navigator: { userActivation: { hasBeenActive: true } }, BroadcastChannel: class { postMessage() {} }, console, sourceKind });
  vm.runInContext(source, context);
  context.settings = initialState();
  vm.runInContext('state = settings; enabled = true;', context);
  const calls = [];
  const entries = Array.from({ length: 12 }, (_, id) => {
    const entry = { ready: true, player: {
      mute() { calls.push(['mute', id]); entry.muted = true; },
      unMute() { calls.push(['unmute', id]); entry.muted = false; },
      setVolume(value) { entry.volume = value; },
      getPlayerState() { return entry.playerState ?? 1; },
      playVideo() { entry.playCount = (entry.playCount || 0) + 1; }
    } };
    context.entry = entry;
    vm.runInContext(`players.set(${id}, entry)`, context);
    return entry;
  });
  return { context, entries, calls, apply: () => vm.runInContext('applyAudio()', context) };
}

test('switching audio mutes every other player before unmuting the selected one', () => {
  const desk = playback();
  desk.context.settings.audio = 5;
  desk.apply();
  assert.deepEqual(desk.calls.filter(call => call[0] === 'unmute'), [['unmute', 5]]);
  desk.calls.length = 0;
  desk.context.settings.audio = 0;
  desk.apply();
  assert.equal(desk.calls.at(-1)[0], 'unmute');
  assert.equal(desk.calls.at(-1)[1], 0);
  assert.equal(desk.entries.filter(entry => !entry.muted).length, 1);
});

test('mute all and initial playback gate silence every player', () => {
  const desk = playback();
  desk.context.settings.audio = null;
  desk.apply();
  assert.ok(desk.entries.every(entry => entry.muted));
  desk.context.settings.audio = 0;
  vm.runInContext('enabled = false', desk.context);
  desk.apply();
  assert.ok(desk.entries.every(entry => entry.muted));
});

test('YouTube selection asks for a TV gesture before attempting audible autoplay', () => {
  const desk = playback();
  desk.context.navigator.userActivation.hasBeenActive = false;
  desk.context.prompts = 0;
  vm.runInContext('requireGesture = () => prompts++', desk.context);
  desk.context.settings.audio = 0;
  desk.apply();
  assert.equal(desk.entries[0].muted, true);
  assert.equal(desk.context.prompts, 1);
  vm.runInContext('audioGesture = true', desk.context);
  desk.apply();
  assert.equal(desk.entries[0].muted, false);
  assert.ok(desk.entries.slice(1).every(entry => entry.muted));
});

test('selecting a paused YouTube channel resumes it as well as unmuting it', () => {
  const desk = playback();
  desk.context.settings.audio = 1;
  desk.entries[1].playerState = 2;
  desk.apply();
  assert.equal(desk.entries[1].muted, false);
  assert.equal(desk.entries[1].playCount, 1);
  assert.ok(desk.entries.filter((_, id) => id !== 1).every(entry => entry.muted));
});

test('direct videos follow the same audio selection and volume', () => {
  const desk = playback();
  const video = { muted: false, volume: 1 };
  desk.context.video = video;
  vm.runInContext('players.set(4, { video })', desk.context);
  desk.context.settings.audio = 4;
  desk.context.settings.volume = 35;
  desk.apply();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.35);
  desk.context.settings.audio = 2;
  desk.apply();
  assert.equal(video.muted, true);
});

function directPlayback() {
  const desk = playback();
  const events = new Map();
  const tracks = [];
  tracks.addEventListener = () => {};
  const video = {
    textTracks: tracks, muted: true, volume: 1, playCount: 0,
    addEventListener(name, callback) { events.set(name, callback); },
    canPlayType() { return ''; },
    play() { this.playCount++; return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute() {}, load() {}
  };
  const media = { replaceChildren() {} };
  const entry = { tile: { querySelector: () => media, remove() {} }, disposed: false };
  desk.context.document.createElement = () => video;
  desk.context.directEntry = entry;
  desk.context.slot = { ...initialState().slots[0], type: 'hls', url: 'https://example.com/stream.m3u8' };
  vm.runInContext('players.set(0, directEntry); loadLibrary = () => Promise.resolve();', desk.context);
  return { ...desk, video, entry, events };
}

test('HLS attaches to the managed video and stops when the source is removed', async () => {
  const desk = directPlayback();
  const callbacks = new Map();
  let engine;
  desk.context.Hls = class {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed' };
    static isSupported() { return true; }
    constructor() { engine = this; }
    on(name, callback) { callbacks.set(name, callback); }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; video.src = 'blob:hls-source'; callbacks.get('attached')(); }
    destroy() { this.destroyed = true; }
  };
  await vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  assert.equal(engine.video, desk.video);
  assert.equal(engine.url, desk.context.slot.url);
  callbacks.get('parsed')();
  assert.equal(desk.video.playCount, 1);
  assert.equal(desk.video.muted, true);
  desk.context.settings.audio = 0;
  desk.apply();
  assert.equal(desk.video.muted, false);
  vm.runInContext('destroy(directEntry)', desk.context);
  assert.equal(engine.destroyed, true);
  assert.equal(desk.video.paused, true);
});

test('removing a source during library loading does not create an orphan stream', async () => {
  const desk = directPlayback();
  let release;
  let created = false;
  desk.context.loadLibrary = () => new Promise(resolve => { release = resolve; });
  desk.context.Hls = class { constructor() { created = true; } };
  const loading = vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  desk.entry.disposed = true;
  release();
  await loading;
  assert.equal(created, false);
});

test('DASH registers playback before initialization and releases its engine', async () => {
  const desk = directPlayback();
  desk.context.slot.type = 'dash';
  desk.context.slot.url = 'https://example.com/manifest.mpd';
  const callbacks = new Map();
  const engine = {
    on(name, callback) { callbacks.set(name, callback); },
    initialize(video, url, autoplay) {
      assert.equal(video, desk.video);
      assert.equal(url, desk.context.slot.url);
      assert.equal(autoplay, false);
      video.src = 'blob:dash-source';
      callbacks.get('initialized')();
    },
    enableText(value) { this.captions = value; },
    reset() { this.stopped = true; }
  };
  const factory = () => ({ create: () => engine });
  factory.events = { ERROR: 'error', STREAM_INITIALIZED: 'initialized' };
  desk.context.dashjs = { MediaPlayer: factory };
  await vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  assert.equal(engine.captions, false);
  assert.equal(desk.video.playCount, 1);
  assert.equal(desk.video.muted, true);
  vm.runInContext('destroy(directEntry)', desk.context);
  assert.equal(engine.stopped, true);
});

test('HLS uses MSE even when the browser claims native manifest support', async () => {
  const desk = directPlayback();
  desk.video.canPlayType = () => 'maybe';
  const callbacks = new Map();
  let source;
  desk.context.Hls = class {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed' };
    static isSupported() { return true; }
    on(name, callback) { callbacks.set(name, callback); }
    attachMedia(video) { video.src = 'blob:mse'; callbacks.get('attached')(); }
    loadSource(url) { source = url; }
  };
  await vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  assert.equal(source, desk.context.slot.url);
  assert.equal(desk.video.src, 'blob:mse');
  assert.equal(desk.video.playCount, 0);
  callbacks.get('parsed')();
  assert.equal(desk.video.playCount, 1);
});

test('playback waits for an attached source and native HLS remains a fallback', async () => {
  const desk = directPlayback();
  await vm.runInContext('playVideo(0, directEntry.video = document.createElement("video"))', desk.context);
  assert.equal(desk.video.playCount, 0);
  desk.video.canPlayType = () => 'probably';
  desk.context.Hls = class { static isSupported() { return false; } };
  await vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  assert.equal(desk.video.src, desk.context.slot.url);
  assert.equal(desk.video.playCount, 1);
});

test('TV commands run once and layout changes do not request fullscreen', () => {
  const desk = playback();
  desk.context.actions = [];
  vm.runInContext('renderDisplay = () => {}; applyTheme = () => {}; enablePlayback = () => actions.push("play"); fullscreenNow = () => { actions.push("fullscreen"); return Promise.resolve(); };', desk.context);
  desk.context.next = { ...initialState(), focus: 0, previews: false };
  vm.runInContext('receive(next)', desk.context);
  assert.deepEqual(desk.context.actions, []);
  desk.context.next = { ...desk.context.next, playbackRequest: 1 };
  vm.runInContext('receive(next); receive(next)', desk.context);
  assert.deepEqual(desk.context.actions, ['play']);
  desk.context.next = { ...desk.context.next, fullscreenRequest: 1 };
  vm.runInContext('receive(next); receive(next)', desk.context);
  assert.deepEqual(desk.context.actions, ['play', 'fullscreen']);
});

test('changing drawer visibility keeps the existing players alive', () => {
  const desk = playback();
  const stage = { style: { setProperty() {} }, append() {} };
  desk.context.document.querySelector = () => stage;
  let destroyed = 0;
  vm.runInContext('players.clear()', desk.context);
  for (let id = 0; id < 4; id++) {
    const entry = desk.entries[id];
    entry.player.destroy = () => { destroyed++; };
    entry.tile = { style: {}, classList: { toggle() {} }, querySelector: () => ({}), remove() {} };
    desk.context.existing = entry;
    vm.runInContext(`existing.key = playerKey(state.slots[${id}]); players.set(${id}, existing);`, desk.context);
  }
  desk.context.settings.focus = 0;
  desk.context.settings.previews = false;
  vm.runInContext('renderDisplay()', desk.context);
  assert.match(stage.className, /focus.*no-previews/);
  desk.context.settings.previews = true;
  vm.runInContext('renderDisplay()', desk.context);
  assert.equal(destroyed, 0);
  assert.equal(vm.runInContext('players.size', desk.context), 4);
  desk.context.settings.order = [3, 2, 1, 0, 4, 5, 6, 7, 8, 9, 10, 11];
  desk.context.settings.audio = 0;
  vm.runInContext('renderDisplay()', desk.context);
  assert.equal(destroyed, 0);
  assert.deepEqual(desk.entries.slice(0, 4).map(entry => entry.tile.style.order), [3, 2, 1, 0]);
  assert.equal(desk.context.settings.focus, 0);
  assert.equal(desk.entries[0].muted, false);
});

test('Shift and number shortcuts select streams 10–12 without stealing text input', () => {
  const desk = playback();
  desk.context.settings.count = 12;
  vm.runInContext('update = patch => { Object.assign(state, typeof patch === "function" ? patch(state) : patch); }', desk.context);
  const press = (key, code, extra = {}) => {
    desk.context.keyEvent = { key, code, target: { tagName: 'BODY' }, preventDefault() {}, ...extra };
    vm.runInContext('handleKeydown(keyEvent)', desk.context);
  };
  for (const [key, code, selected] of [['!', 'Digit1', 9], ['@', 'Digit2', 10], ['#', 'Digit3', 11]]) {
    press(key, code, { shiftKey: true });
    assert.equal(desk.context.settings.focus, selected);
    assert.equal(desk.context.settings.audio, selected);
  }
  press('9', 'Digit9', { target: { tagName: 'BUTTON' } });
  assert.equal(desk.context.settings.focus, 8);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { target: { tagName: 'INPUT' } }, { target: { tagName: 'SPAN', isContentEditable: true } }]) press('1', 'Digit1', extra);
  assert.equal(desk.context.settings.focus, 8);
  desk.context.settings.count = 9;
  press('!', 'Digit1', { shiftKey: true });
  assert.equal(desk.context.settings.focus, 8);
  press('1', 'Digit1');
  assert.equal(desk.context.settings.focus, 0);
});

test('move buttons swap only visible placements and keep hidden streams and audio intact', () => {
  const desk = playback();
  desk.context.settings.order = [3, 7, 0, 1, 2, 4, 5, 6, 8, 9, 10, 11];
  desk.context.settings.focus = 0;
  desk.context.settings.audio = 0;
  vm.runInContext('update = patch => { Object.assign(state, typeof patch === "function" ? patch(state) : patch); }; moveStream(0, -1);', desk.context);
  assert.deepEqual(Array.from(desk.context.settings.order), [0, 7, 3, 1, 2, 4, 5, 6, 8, 9, 10, 11]);
  vm.runInContext('moveStream(0, -1); moveStream(2, 1)', desk.context);
  assert.deepEqual(Array.from(desk.context.settings.order), [0, 7, 3, 1, 2, 4, 5, 6, 8, 9, 10, 11]);
  assert.equal(desk.context.settings.focus, 0);
  assert.equal(desk.context.settings.audio, 0);
});

test('numbers and shortcuts follow reordered positions while audio stays with its source', () => {
  const desk = playback();
  desk.context.settings.count = 12;
  desk.context.settings.order = [11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  desk.context.settings.audio = 4;
  desk.context.settings.follow = false;
  assert.equal(vm.runInContext('streamNumber(11)', desk.context), 1);
  assert.equal(vm.runInContext('streamNumber(8)', desk.context), 10);
  vm.runInContext('update = patch => { Object.assign(state, typeof patch === "function" ? patch(state) : patch); }', desk.context);
  desk.context.keyEvent = { key: '1', code: 'Digit1', target: { tagName: 'BODY' }, preventDefault() {} };
  vm.runInContext('handleKeydown(keyEvent)', desk.context);
  assert.equal(desk.context.settings.focus, 11);
  desk.context.keyEvent = { ...desk.context.keyEvent, key: '!', shiftKey: true };
  vm.runInContext('handleKeydown(keyEvent)', desk.context);
  assert.equal(desk.context.settings.focus, 8);
  assert.equal(desk.context.settings.audio, 4);
  desk.context.settings.count = 4;
  assert.equal(vm.runInContext('streamNumber(0)', desk.context), 1);
  assert.equal(vm.runInContext('streamNumber(3)', desk.context), 4);
});

test('opening and closing YouTube settings does not replace its player', () => {
  const desk = playback();
  desk.context.slot = { ...initialState().slots[0], url: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const before = vm.runInContext('playerKey(slot)', desk.context);
  desk.context.settings.youtubeSettings = 0;
  assert.equal(vm.runInContext('playerKey(slot)', desk.context), before);
  desk.context.settings.youtubeSettings = null;
  assert.equal(vm.runInContext('playerKey(slot)', desk.context), before);
});

function healthDesk() {
  const desk = playback();
  const built = [];
  const messages = [];
  const stage = { style: { setProperty() {} }, append() {} };
  desk.context.document.querySelector = () => stage;
  desk.context.messages = messages;
  desk.context.makeEntry = id => {
    const fields = new Map();
    const entry = {
      id, ready: true, position: 0, playerState: 1, muted: true, volume: 80,
      tile: { style: {}, classList: { toggle() {} }, querySelector(selector) { if (!fields.has(selector)) fields.set(selector, {}); return fields.get(selector); }, remove() {} }
    };
    entry.player = {
      getPlayerState: () => entry.playerState,
      getCurrentTime: () => entry.position,
      isMuted: () => entry.muted,
      getVolume: () => entry.volume,
      setVolume: value => { entry.volume = value; },
      mute: () => { entry.muted = true; },
      unMute: () => { entry.muted = false; },
      playVideo() {},
      destroy: () => { entry.destroyed = true; }
    };
    built.push(entry);
    return entry;
  };
  for (const slot of desk.context.settings.slots) slot.url = 'https://www.youtube.com/watch?v=KQhNZQ_Uag8';
  desk.context.settings.focus = 0;
  desk.context.settings.audio = 0;
  vm.runInContext('players.clear(); status = (id, message) => messages.push({ id, message }); createTile = slot => { const entry = makeEntry(slot.id); entry.key = playerKey(slot); return entry; }; renderDisplay()', desk.context);
  const entry = id => vm.runInContext(`players.get(${id})`, desk.context);
  const check = now => vm.runInContext(`checkPlaybackHealth(${now})`, desk.context);
  return { ...desk, built, messages, entry, check };
}

test('a frozen display player reconnects without rebuilding healthy players or changing audio', () => {
  const desk = healthDesk();
  const original = [0, 1, 2, 3].map(desk.entry);
  desk.check(0);
  for (const entry of original.slice(1)) entry.position = 16;
  desk.check(16000);
  assert.match(original[0].recovery.reason, /stopped advancing/);
  desk.check(18000);
  assert.equal(original[0].destroyed, true);
  assert.notEqual(desk.entry(0), original[0]);
  for (const entry of original.slice(1)) assert.equal(desk.entry(entry.id), entry);
  assert.equal(desk.context.settings.focus, 0);
  assert.equal(desk.context.settings.audio, 0);
  assert.equal(desk.entry(0).muted, false);
  assert.ok(original.slice(1).every(entry => entry.muted));
});

test('ended YouTube playback has bounded reconnects and manual Reload starts a new recovery budget', () => {
  const desk = healthDesk();
  let now = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    desk.entry(0).playerState = 0;
    desk.check(now);
    const at = desk.entry(0).recovery.at;
    assert.ok(at > now);
    desk.check(at);
    now = at + 1;
  }
  desk.entry(0).playerState = 0;
  desk.check(now);
  assert.equal(desk.entry(0).recoveryExhausted, true);
  assert.match(desk.messages.at(-1).message, /exhausted/);
  desk.context.settings.slots[0].reload++;
  vm.runInContext('renderDisplay()', desk.context);
  desk.entry(0).playerState = 0;
  desk.check(now + 1);
  assert.ok(desk.entry(0).recovery);
  assert.notEqual(desk.entry(0).recoveryExhausted, true);
});

test('scheduled YouTube streams and known playback permission blocks are not reloaded', () => {
  const desk = healthDesk();
  desk.entry(0).playerState = 5;
  for (const id of [1, 2, 3]) desk.entry(id).autoplayBlocked = true;
  desk.check(0);
  desk.check(60000);
  assert.equal(desk.built.length, 4);
  assert.ok([0, 1, 2, 3].every(id => !desk.entry(id).recovery));
});

test('offline and hidden display tabs do not spend reconnect attempts', () => {
  const desk = healthDesk();
  desk.entry(0).playerState = 0;
  desk.context.navigator.onLine = false;
  desk.check(0);
  desk.check(60000);
  assert.equal(desk.entry(0).recovery, undefined);
  desk.context.navigator.onLine = true;
  desk.context.document.hidden = true;
  desk.check(60001);
  assert.equal(desk.entry(0).recovery, undefined);
  desk.context.document.hidden = false;
  desk.check(60002);
  assert.ok(desk.entry(0).recovery);
});

test('a running YouTube player that resets mute and volume recovers without a reload', () => {
  const desk = healthDesk();
  desk.check(0);
  assert.equal(desk.entry(0).audioConfirmed, true);
  desk.entry(0).muted = true;
  desk.entry(0).volume = 0;
  desk.context.navigator.userActivation.hasBeenActive = false;
  desk.check(2000);
  assert.equal(desk.entry(0).muted, false);
  assert.equal(desk.entry(0).volume, 80);
  assert.equal(desk.built.length, 4);
  desk.context.settings.audio = null;
  desk.apply();
  desk.check(4000);
  assert.ok([0, 1, 2, 3].every(id => desk.entry(id).muted));
});

test('a failed YouTube API does not prevent another stream from receiving audio', () => {
  const desk = healthDesk();
  desk.context.settings.audio = 1;
  desk.entry(0).player.mute = () => { throw new Error('Disconnected iframe'); };
  desk.apply();
  assert.equal(desk.entry(1).muted, false);
  assert.match(desk.entry(0).recovery.reason, /Disconnected iframe/);
  desk.entry(0).player.destroy = () => { throw new Error('Disconnected iframe'); };
  desk.check(desk.entry(0).recovery.at);
  assert.equal(desk.built.length, 5);
  assert.equal(desk.entry(1).muted, false);
});

test('optional caption API failures do not interrupt player initialization', () => {
  const desk = playback();
  desk.context.captionPlayer = { getOptions() { throw new Error('No caption module'); } };
  assert.doesNotThrow(() => vm.runInContext('hideCaptions(captionPlayer)', desk.context));
});

test('fatal HLS errors schedule automatic reconnect rather than permanently removing the video', async () => {
  const desk = directPlayback();
  const callbacks = new Map();
  let engine;
  desk.context.settings.slots[0] = desk.context.slot;
  desk.context.messages = [];
  vm.runInContext('status = (id, message) => messages.push({ id, message })', desk.context);
  desk.context.Hls = class {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed' };
    static isSupported() { return true; }
    constructor() { engine = this; }
    on(name, callback) { callbacks.set(name, callback); }
    loadSource() {}
    attachMedia(video) { video.src = 'blob:hls'; callbacks.get('attached')(); }
    destroy() { this.destroyed = true; }
  };
  await vm.runInContext('loadDirect(slot, directEntry)', desk.context);
  callbacks.get('error')(null, { fatal: true, details: 'manifestLoadError', response: { code: 503 } });
  assert.match(desk.entry.recovery.reason, /manifestLoadError 503/);
  assert.notEqual(desk.entry.failed, true);
  assert.notEqual(engine.destroyed, true);
  assert.match(desk.context.messages.at(-1).message, /Reconnecting automatically/);
});

test('decoded video stalls are detected even while the audio playback clock advances', () => {
  const desk = healthDesk();
  desk.context.settings.slots[0].type = 'hls';
  const entry = desk.entry(0);
  entry.ready = false;
  entry.video = { currentTime: 1, videoWidth: 1920, getVideoPlaybackQuality: () => ({ totalVideoFrames: 10 }) };
  desk.check(0);
  entry.video.currentTime = 17;
  for (const id of [1, 2, 3]) desk.entry(id).position = 17;
  desk.check(16000);
  assert.match(entry.recovery.reason, /stopped advancing/);
});

test('hidden previews are left alone unless they supply the selected audio', () => {
  const desk = healthDesk();
  desk.context.settings.previews = false;
  for (const id of [1, 2, 3]) desk.entry(id).playerState = 0;
  desk.check(0);
  assert.ok([1, 2, 3].every(id => !desk.entry(id).recovery));
  desk.context.settings.audio = 1;
  desk.check(2000);
  assert.ok(desk.entry(1).recovery);
  assert.equal(desk.entry(2).recovery, undefined);
});
