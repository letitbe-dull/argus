import { youtubeId, sourceKind } from './state.mjs';

const $ = selector => document.querySelector(selector);
const display = document.body.dataset.mode === 'display';
let state;
let pending = Promise.resolve();
const players = new Map();
const recoveries = new Map();
let youtubeReady;
const youtube = new Promise(resolve => { youtubeReady = resolve; });
const statuses = new Map();
let enabled = display;
let audioGesture = false;
let pendingFullscreen = false;
let syncDial;
const libraries = new Map();

function report(message) {
  $('#error').textContent = message;
  $('#error').hidden = !message;
}

function update(patch) {
  pending = pending.catch(() => {}).then(async () => {
    const response = await fetch('/api/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(typeof patch === 'function' ? patch(state) : patch)
    });
    if (!response.ok) throw new Error(await response.text());
    receive(await response.json());
    report('');
    return true;
  }).catch(error => { report(`Could not save: ${error.message}`); return false; });
  return pending;
}

function focus(id) {
  update(current => ({ focus: id, ...(current.follow && id !== null ? { audio: id } : {}) }));
}

function streamNumber(id) {
  return state.order.filter(source => source < state.count).indexOf(id) + 1;
}

function moveStream(id, direction) {
  update(current => {
    const order = [...current.order];
    const visible = order.filter(source => source < current.count);
    const position = visible.indexOf(id);
    const neighbor = visible[position + direction];
    if (position < 0 || neighbor === undefined) return {};
    const first = order.indexOf(id);
    const second = order.indexOf(neighbor);
    [order[first], order[second]] = [order[second], order[first]];
    return { order };
  });
}

function receive(next) {
  if (state && next.session === state.session && next.revision < state.revision) return;
  const previous = state;
  state = next;
  applyTheme(next.theme || 'auto');
  if (display) renderDisplay();
  else renderControl(previous);
  if (display && previous) {
    if ((next.playbackRequest || 0) !== (previous.playbackRequest || 0)) enablePlayback();
    if ((next.fullscreenRequest || 0) !== (previous.fullscreenRequest || 0)) fullscreenNow().catch(() => requireGesture(true));
  }
}

function button(label, action, className = '') {
  const element = document.createElement('button');
  element.textContent = label;
  element.className = className;
  element.addEventListener('click', action);
  return element;
}

function renderControl(previous) {
  $('#count').value = state.count;
  syncDial?.(state.count);
  $('#volume').value = state.volume;
  $('#follow').checked = state.follow;
  $('#layout-status').textContent = state.focus === null ? `${state.count} streams · Grid view` : `Focused · ${state.slots[state.focus].name}`;
  $('#audio-status').textContent = state.audio === null ? 'All muted' : `Audio · ${state.slots[state.audio].name} · ${state.volume}%`;
  $('#grid').classList.toggle('active', state.focus === null);
  $('#previews span').textContent = state.previews === false ? 'Show previews' : 'Hide previews';
  $('#previews').disabled = state.focus === null;
  $('#previews').setAttribute('aria-pressed', state.previews !== false);
  $('#youtube-controls').textContent = state.youtubeControls ? 'Hide YouTube controls' : 'Show YouTube controls';
  $('#youtube-controls').classList.toggle('active', state.youtubeControls === true);
  $('#youtube-controls').setAttribute('aria-pressed', state.youtubeControls === true);
  $('#mute').classList.toggle('active', state.audio === null);
  if (!previous || previous.count !== state.count || JSON.stringify(previous.slots) !== JSON.stringify(state.slots)) {
    $('#controls').replaceChildren(...state.slots.slice(0, state.count).map(controlCard));
  }
  state.slots.slice(0, state.count).forEach(slot => {
    const card = $(`#control-${slot.id}`);
    const visible = state.order.filter(id => id < state.count);
    const number = streamNumber(slot.id);
    card.querySelector('.number').textContent = String(number).padStart(2, '0');
    card.querySelector('[data-action=focus]').title = `Shortcut: ${number <= 9 ? number : `Shift+${number - 9}`}`;
    card.style.order = state.order.indexOf(slot.id);
    card.querySelector('[data-action=earlier]').disabled = visible[0] === slot.id;
    card.querySelector('[data-action=later]').disabled = visible.at(-1) === slot.id;
    card.classList.toggle('focused', state.focus === slot.id);
    card.querySelector('[data-action=focus]').classList.toggle('active', state.focus === slot.id);
    card.querySelector('[data-action=audio]').classList.toggle('active', state.audio === slot.id);
    card.querySelector('.badge').textContent = state.audio === slot.id ? 'Listening' : 'Muted';
    card.querySelector('.source-note').textContent = statuses.get(slot.id) || (slot.url ? { youtube: 'YouTube', hls: 'HLS stream', dash: 'DASH stream', video: 'Video URL' }[sourceKind(slot)] : 'No video link');
    card.querySelector('[data-action=focus]').setAttribute('aria-pressed', state.focus === slot.id);
    card.querySelector('[data-action=audio]').setAttribute('aria-pressed', state.audio === slot.id);
    const settings = card.querySelector('[data-action=youtube-settings]');
    if (settings) {
      const open = state.youtubeSettings === slot.id;
      settings.textContent = open ? 'Hide YouTube settings' : 'YouTube settings';
      settings.classList.toggle('active', open);
      settings.setAttribute('aria-pressed', open);
    }
  });
}

function controlCard(slot) {
  const card = document.createElement('article');
  card.className = 'source-card';
  card.id = `control-${slot.id}`;
  card.innerHTML = `<div class="card-heading"><span class="number">${String(slot.id + 1).padStart(2, '0')}</span><span class="card-name"></span><span class="badge"></span></div><div class="card-actions"></div><div class="source-meta"><p class="source-note"></p><a class="source-link" target="_blank" rel="noopener noreferrer">Open source ↗</a></div><details class="source-editor"><summary>Edit source</summary><form class="source-form"><label>Name<input type="text" name="name" maxlength="60" required></label><label>Source<select name="type"><option value="video">Video URL (auto)</option><option value="hls">HLS (.m3u8)</option><option value="dash">DASH (.mpd)</option><option value="youtube">YouTube</option></select></label><label class="wide">Video link / stream URL<input type="text" name="url" placeholder="YouTube or direct stream URL"></label><button type="submit">Save source</button></form></details>`;
  card.querySelector('.card-name').textContent = slot.name;
  const reorder = document.createElement('div');
  reorder.className = 'reorder-actions';
  for (const [label, action, direction] of [['↑', 'earlier', -1], ['↓', 'later', 1]]) {
    const move = button(label, () => moveStream(slot.id, direction));
    move.dataset.action = action;
    move.title = `Move ${slot.name} ${action}`;
    move.setAttribute('aria-label', move.title);
    reorder.append(move);
  }
  card.querySelector('.card-heading').append(reorder);
  const form = card.querySelector('form');
  form.elements.name.value = slot.name;
  form.elements.type.value = slot.type;
  form.elements.url.value = slot.url;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    await update(current => ({ slots: current.slots.map(item => item.id === slot.id ? { ...item, ...values } : item) }));
  });
  const actions = card.querySelector('.card-actions');
  const focusButton = button('Focus', () => focus(slot.id));
  focusButton.dataset.action = 'focus';
  const audioButton = button('Listen', () => update({ audio: slot.id }));
  audioButton.dataset.action = 'audio';
  actions.append(focusButton, audioButton, button('Reload', () => update(current => ({ slots: current.slots.map(item => item.id === slot.id ? { ...item, reload: item.reload + 1 } : item) }))));
  if (slot.url && sourceKind(slot) === 'youtube') {
    const settings = button('YouTube settings', () => update(current => current.youtubeSettings === slot.id ? { youtubeSettings: null } : { youtubeSettings: slot.id, focus: slot.id, ...(current.follow ? { audio: slot.id } : {}) }));
    settings.dataset.action = 'youtube-settings';
    const tools = document.createElement('div');
    tools.className = 'youtube-tools';
    tools.append(settings);
    const hint = document.createElement('span');
    hint.textContent = 'In the TV player: gear → Quality → 1080p';
    tools.append(hint);
    actions.after(tools);
  }
  const link = card.querySelector('a');
  const source = slot.url;
  if (source) link.href = /^[\w-]{11}$/.test(source) ? `https://www.youtube.com/watch?v=${source}` : source;
  else link.remove();
  return card;
}

function playerKey(slot) {
  const controls = state?.youtubeControls === true && Boolean(slot.url) && sourceKind(slot) === 'youtube';
  return JSON.stringify([slot.type, slot.url, slot.reload, controls]);
}

function status(id, message) {
  fetch('/api/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, message })
  }).catch(() => {});
}

function destroy(entry) {
  entry.disposed = true;
  try { entry.player?.destroy(); } catch {}
  try { entry.hls?.destroy(); } catch {}
  try { entry.dash?.reset(); } catch {}
  if (entry.video) {
    entry.video.pause();
    entry.video.srcObject = null;
    entry.video.removeAttribute('src');
    entry.video.load();
  }
  entry.tile.remove();
}

function queueRecovery(id, entry, reason, now = Date.now()) {
  const slot = state?.slots[id];
  if (!slot?.url || entry.disposed || entry.recoveryExhausted) return false;
  const key = playerKey(slot);
  let recovery = recoveries.get(id);
  if (!recovery || recovery.key !== key) {
    recovery = { key, attempts: [] };
    recoveries.set(id, recovery);
  }
  recovery.attempts = recovery.attempts.filter(time => now - time < 300000);
  if (recovery.attempts.length >= 3) {
    entry.recoveryExhausted = true;
    status(id, `${reason} Automatic reconnects exhausted; use Reload on this source.`);
    return false;
  }
  if (!entry.recovery) {
    entry.recovery = { at: now + 2000 * 2 ** recovery.attempts.length, reason };
    status(id, `${reason} Reconnecting automatically (${recovery.attempts.length + 1}/3).`);
  }
  return true;
}

function checkPlaybackHealth(now = Date.now()) {
  if (!state || document.hidden || navigator.onLine === false) return;
  for (const [id, entry] of [...players]) {
    if (id >= state.count || entry.disposed || entry.recoveryExhausted || entry.autoplayBlocked) continue;
    if (state.focus !== null && state.previews === false && id !== state.focus && id !== state.audio) continue;
    const slot = state.slots[id];
    if (!slot.url) continue;
    if (entry.recovery) {
      if (now < entry.recovery.at) continue;
      const recovery = recoveries.get(id);
      if (recovery?.key !== playerKey(slot)) continue;
      recovery.attempts.push(now);
      entry.key = null;
      renderDisplay();
      continue;
    }
    try {
      let position;
      if (sourceKind(slot) === 'youtube') {
        if (!entry.ready) {
          entry.health ||= { at: now };
          if (now - entry.health.at >= 30000) queueRecovery(id, entry, 'YouTube did not become ready.', now);
          continue;
        }
        const playback = entry.player.getPlayerState();
        if (playback === 0) { queueRecovery(id, entry, 'YouTube reported finished playback.', now); continue; }
        if (playback === 1) {
          entry.hasPlayed = true;
          if (enabled && state.audio === id && state.volume > 0) {
            const muted = entry.player.isMuted?.();
            const volume = entry.player.getVolume?.();
            if (muted === false && volume > 0) entry.audioConfirmed = true;
            if (muted === true || (Number.isFinite(volume) && volume !== state.volume)) applyAudio();
          }
        }
        if (!entry.hasPlayed && [-1, 5].includes(playback)) { entry.health = null; continue; }
        position = entry.player.getCurrentTime?.();
      } else if (entry.video) {
        if (entry.video.ended) {
          if (['hls', 'dash'].includes(slot.type) || ['hls', 'dash'].includes(sourceKind(slot))) queueRecovery(id, entry, 'Live video stopped.', now);
          continue;
        }
        const frames = entry.video.getVideoPlaybackQuality?.().totalVideoFrames;
        position = Number.isFinite(frames) && (entry.video.videoWidth > 0) ? frames : entry.video.currentTime;
      }
      if (!Number.isFinite(position)) continue;
      if (!entry.health || !Number.isFinite(entry.health.position) || Math.abs(position - entry.health.position) > 0.1) entry.health = { at: now, position };
      else if (now - entry.health.at >= 15000) queueRecovery(id, entry, 'Playback stopped advancing for 15 seconds.', now);
    } catch (error) { queueRecovery(id, entry, `Player connection failed: ${error.message}`, now); }
  }
}

function renderDisplay() {
  const stage = $('#stage');
  stage.className = `stage ${state.focus !== null ? 'focus' : ''} ${state.previews === false ? 'no-previews' : ''}`;
  const columns = state.count <= 4 ? 2 : state.count <= 9 ? 3 : 4;
  stage.style.setProperty('--columns', columns);
  stage.style.setProperty('--rows', Math.ceil(state.count / columns));
  stage.style.setProperty('--previews', state.count - 1);
  for (const [id, entry] of players) {
    const slot = state.slots[id];
    if (id >= state.count || entry.key !== playerKey(slot)) {
      destroy(entry);
      players.delete(id);
    }
  }
  state.slots.slice(0, state.count).forEach(slot => {
    let entry = players.get(slot.id);
    if (!entry) {
      entry = createTile(slot);
      players.set(slot.id, entry);
      stage.append(entry.tile);
    }
    entry.tile.style.order = state.order.indexOf(slot.id);
    entry.tile.classList.toggle('main', state.focus === slot.id);
    entry.tile.classList.toggle('audible', state.audio === slot.id);
    entry.tile.querySelector('.tile-name').textContent = `${String(streamNumber(slot.id)).padStart(2, '0')}  ${slot.name}`;
    entry.tile.querySelector('.audio-indicator').textContent = state.audio === slot.id ? 'Listening' : 'Muted';
    entry.youtubeFrame?.classList.toggle('youtube-settings', state.youtubeSettings === slot.id);

  });
  applyAudio();
}

function createTile(slot) {
  const tile = document.createElement('section');
  tile.className = 'tile';
  tile.dataset.id = slot.id;
  tile.innerHTML = '<div class="media"></div><div class="tile-footer"><span class="tile-name"></span><span class="audio-indicator"></span></div>';
  const entry = { tile, key: playerKey(slot), disposed: false };
  const media = tile.querySelector('.media');
  const empty = document.createElement('div');
  empty.className = 'empty';
  const title = document.createElement('strong');
  title.textContent = slot.name;
  const detail = document.createElement('p');
  empty.append(title, detail);
  media.append(empty);
  if (!slot.url) {
    detail.textContent = 'Add a YouTube or direct stream URL in the controls.';
    return entry;
  }
  if (sourceKind(slot) !== 'youtube') {
    loadDirect(slot, entry);
    return entry;
  }
  detail.textContent = 'Connecting to YouTube…';
  youtube.then(() => {
    if (entry.disposed) return;
    const mount = document.createElement('iframe');
    mount.id = `player-${slot.id}-${Date.now()}`;
    mount.title = slot.name;
    mount.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    mount.allowFullscreen = true;
    mount.classList.add('youtube-player');
    mount.classList.toggle('youtube-settings', state.youtubeSettings === slot.id);
    entry.youtubeFrame = mount;
    const controls = state.youtubeControls === true ? 1 : 0;
    const parameters = new URLSearchParams({ enablejsapi: '1', autoplay: '1', mute: '1', playsinline: '1', controls: String(controls), disablekb: '1', rel: '0', origin: location.origin });
    mount.src = `https://www.youtube.com/embed/${youtubeId(slot.url)}?${parameters}`;
    media.replaceChildren(mount);
    entry.player = new YT.Player(mount, {
      videoId: youtubeId(slot.url),
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, controls, disablekb: 1, rel: 0, origin: location.origin },
      events: {
        onReady: event => { entry.ready = true; hideCaptions(event.target); applyAudio(); entry.player.playVideo(); status(slot.id, 'Player ready'); },
        onStateChange: event => {
          if (entry.disposed) return;
          if (event.data === 1) { entry.autoplayBlocked = false; entry.recovery = null; entry.health = null; applyAudio(); }
          if (event.data === 0) queueRecovery(slot.id, entry, 'YouTube reported finished playback.');
        },
        onApiChange: event => hideCaptions(event.target),
        onAutoplayBlocked: () => { entry.autoplayBlocked = true; requireGesture(); status(slot.id, 'Click once in the TV window to allow playback.'); },
        onError: event => {
          const message = [101, 150].includes(event.data) ? 'This video blocks embedding. Open it on YouTube or choose another source.' : `YouTube error ${event.data}. Check the video link and whether embedding is allowed.`;
          status(slot.id, message);
          media.replaceChildren();
          detail.textContent = message;
          empty.replaceChildren(title, detail);
          media.append(empty);
        }
      }
    });
  });
  return entry;
}

function hideCaptions(player) {
  try {
    if (player.getOptions?.()?.includes('captions')) player.unloadModule?.('captions');
  } catch {}
}

function loadLibrary(name, url) {
  if (!libraries.has(name)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error(`Could not load the ${name} player. Check your connection and reload this source.`)); };
      document.head.append(script);
    }).catch(error => { libraries.delete(name); throw error; });
    libraries.set(name, promise);
  }
  return libraries.get(name);
}

function playVideo(id, video) {
  if (!video.currentSrc && !video.src && !video.srcObject) return Promise.resolve();
  return video.play().catch(error => {
    if (players.get(id)?.disposed || players.get(id)?.video !== video) return;
    if (error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') {
      players.get(id).autoplayBlocked = true;
      requireGesture();
      status(id, 'Click once in the TV window to allow playback.');
    } else status(id, `Playback failed: ${error.message}`);
  });
}

async function loadDirect(slot, entry) {
  const media = entry.tile.querySelector('.media');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  entry.video = video;
  media.replaceChildren(video);
  const fail = message => {
    if (entry.disposed || entry.failed) return;
    if (queueRecovery(slot.id, entry, message)) return;
    if (entry.recoveryExhausted) message += ' Automatic reconnects exhausted; use Reload on this source.';
    entry.failed = true;
    status(slot.id, message);
    video.pause();
    entry.hls?.destroy();
    entry.dash?.reset();
    const panel = document.createElement('div');
    panel.className = 'empty';
    const text = document.createElement('p');
    text.textContent = message;
    panel.append(text);
    media.replaceChildren(panel);
  };
  const streamError = 'Cannot play this URL. Use a direct video or manifest URL; check codecs, access, expiry, and cross-origin permissions.';
  video.addEventListener('volumechange', () => enforceVideoAudio(slot.id, entry));
  const hideTracks = () => { for (const track of video.textTracks) track.mode = 'disabled'; };
  video.textTracks.addEventListener('addtrack', hideTracks);
  video.addEventListener('loadedmetadata', hideTracks);
  video.addEventListener('playing', () => { if (!entry.failed) { entry.autoplayBlocked = false; entry.recovery = null; entry.health = null; status(slot.id, 'Playing'); } });
  video.addEventListener('error', () => fail(streamError));
  try {
    const kind = sourceKind(slot);
    if (kind === 'hls') {
      await loadLibrary('HLS', '/vendor/hls.min.js');
      if (entry.disposed) return;
      if (Hls.isSupported()) {
        entry.hls = new Hls({ enableWebVTT: false, enableIMSC1: false, enableCEA708Captions: false });
        entry.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(`${streamError} ${[data.details, data.response?.code].filter(Boolean).join(' ')}`.trim()); });
        entry.hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (!entry.disposed) entry.hls.loadSource(slot.url); });
        entry.hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!entry.disposed) { applyAudio(); playVideo(slot.id, video); } });
        entry.hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = slot.url;
        applyAudio();
        await playVideo(slot.id, video);
      } else throw new Error('HLS is unavailable in this browser. Try desktop Chrome or Safari.');
    } else if (kind === 'dash') {
      await loadLibrary('DASH', '/vendor/dash.all.min.js');
      if (entry.disposed) return;
      entry.dash = dashjs.MediaPlayer().create();
      entry.dash.on(dashjs.MediaPlayer.events.ERROR, () => fail(streamError));
      entry.dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        entry.dash.enableText(false);
        applyAudio();
        playVideo(slot.id, video);
      });
      entry.dash.initialize(video, slot.url, false);
    } else {
      video.src = slot.url;
      applyAudio();
      await playVideo(slot.id, video);
    }
    applyAudio();
  } catch (error) { fail(error.message); }
}

function enforceVideoAudio(id, entry) {
  const muted = state.audio !== id || !enabled;
  if (entry.video.muted !== muted) entry.video.muted = muted;
  const volume = state.volume / 100;
  if (entry.video.volume !== volume) entry.video.volume = volume;
}

function applyAudio() {
  for (const [id, entry] of players) {
    if (entry.ready && (state.audio !== id || !enabled)) {
      try { entry.player.mute(); } catch (error) { queueRecovery(id, entry, `YouTube controls stopped responding: ${error.message}`); }
    }
    if (entry.video && (state.audio !== id || !enabled)) entry.video.muted = true;
  }
  for (const [id, entry] of players) {
    if (entry.ready && enabled && state.audio === id) {
      try {
        entry.player.setVolume(state.volume);
        if (!audioGesture && !entry.audioConfirmed && !navigator.userActivation?.hasBeenActive) {
          entry.player.mute();
          requireGesture();
        } else {
          entry.player.unMute();
          if ([-1, 2, 5].includes(entry.player.getPlayerState?.())) entry.player.playVideo();
        }
      } catch (error) { queueRecovery(id, entry, `YouTube controls stopped responding: ${error.message}`); }
    }
    if (entry.video) enforceVideoAudio(id, entry);
  }
}

async function startDisplay() {
  window.onYouTubeIframeAPIReady = () => youtubeReady();
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => report('Could not load YouTube. Check your internet connection and reload the TV window.');
  document.head.append(script);
  $('#authorize').onclick = () => {
    audioGesture = true;
    const fullscreen = pendingFullscreen;
    pendingFullscreen = false;
    enablePlayback();
    if (fullscreen) fullscreenNow().catch(error => report(error.message));
  };
  connect();
  setInterval(checkPlaybackHealth, 2000);
  document.addEventListener('visibilitychange', () => {
    players.forEach(entry => { entry.health = null; });
    if (!document.hidden) checkPlaybackHealth();
  });
  window.addEventListener('online', () => checkPlaybackHealth());
  window.addEventListener('blur', reclaimKeyboard);
}

function reclaimKeyboard() {
  setTimeout(() => {
    const frame = document.activeElement;
    if (frame?.tagName !== 'IFRAME' || frame.classList.contains('youtube-settings')) return;
    frame.blur();
    window.focus();
  });
}

function enablePlayback() {
  enabled = true;
  const permission = $('#permission');
  if (permission) permission.hidden = true;
  players.forEach(entry => { entry.autoplayBlocked = false; });
  applyAudio();
  players.forEach(entry => {
    if (entry.ready) entry.player.playVideo();
    if (entry.video) playVideo(Number(entry.tile.dataset.id), entry.video);
  });
  report('');
}

function requireGesture(fullscreen = false) {
  pendingFullscreen ||= fullscreen;
  $('#authorize').textContent = pendingFullscreen ? 'Click once to enter fullscreen' : 'Click once to enable sound and video';
  $('#permission').hidden = false;
}

async function fullscreenNow() {
  return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
}

function connect() {
  const events = new EventSource('/events');
  events.addEventListener('status', event => {
    statuses.clear();
    for (const [id, message] of Object.entries(JSON.parse(event.data))) statuses.set(Number(id), message);
    if (!display && state) renderControl(state);
  });
  events.onmessage = event => {
    receive(JSON.parse(event.data));
    if (!display) { $('#connection').textContent = 'Connected'; $('#connection').classList.add('online'); }
    else if ($('#error').textContent.startsWith('Server disconnected')) report('');
  };
  events.onerror = () => {
    if (display) report('Server disconnected. Reconnecting; controls will resume when the server returns.');
    else { $('#connection').textContent = 'Reconnecting…'; $('#connection').classList.remove('online'); }
  };
}

function handleKeydown(event) {
  if (!state || event.ctrlKey || event.metaKey || event.altKey || event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  const digit = event.code?.match(/^Digit([1-9])$/)?.[1] || (/^[1-9]$/.test(event.key) ? event.key : null);
  const position = digit === null ? -1 : Number(digit) - 1 + (event.shiftKey ? 9 : 0);
  if (position >= 0 && position < state.count) { event.preventDefault(); focus(state.order.filter(id => id < state.count)[position]); return; }
  if (event.key.toLowerCase() === 'g' || event.key === 'Escape') focus(null);
  if (event.key.toLowerCase() === 'm') update({ audio: null });
  if (event.key.toLowerCase() === 'f') {
    if (display) fullscreenNow().catch(() => requireGesture(true));
    else update(current => ({ fullscreenRequest: (current.fullscreenRequest || 0) + 1 }));
  }
  if (event.key.toLowerCase() === 'h' && state.focus !== null) update(current => ({ previews: current.previews === false }));
}
document.addEventListener('keydown', handleKeydown);

/**
 * Turn a rotary dial into the input for a hidden select.
 * @param {HTMLElement} dial
 * @param {HTMLSelectElement} select
 * @param {HTMLOutputElement} readout
 * @returns {(value: number) => void} Shows a value saved elsewhere.
 */
function setupDial(dial, select, readout) {
  const values = [...select.options].map(option => Number(option.value));
  const step = 270 / (values.length - 1);
  const angle = value => -135 + values.indexOf(value) * step;
  for (const value of values) {
    const tick = document.createElement('span');
    tick.className = 'dial-tick';
    tick.dataset.value = value;
    tick.style.setProperty('--a', `${angle(value)}deg`);
    dial.append(tick);
  }
  let shown = Number(select.value);
  let timer = null;
  let dragging = false;
  const show = value => {
    shown = value;
    dial.style.setProperty('--angle', `${angle(value)}deg`);
    dial.setAttribute('aria-valuenow', value);
    readout.value = value;
    dial.querySelectorAll('.dial-tick').forEach(tick => tick.classList.toggle('on', Number(tick.dataset.value) <= value));
  };
  const commit = value => {
    clearTimeout(timer);
    timer = null;
    show(value);
    if (Number(select.value) === value) return;
    select.value = String(value);
    select.dispatchEvent(new Event('change'));
  };
  const nudge = direction => {
    const index = Math.min(values.length - 1, Math.max(0, values.indexOf(shown) + direction));
    show(values[index]);
    clearTimeout(timer);
    timer = setTimeout(() => commit(shown), 300);
  };
  const fromPointer = event => {
    const box = dial.getBoundingClientRect();
    const degrees = Math.atan2(event.clientX - (box.left + box.width / 2), (box.top + box.height / 2) - event.clientY) * 180 / Math.PI;
    show(values[Math.round((Math.min(135, Math.max(-135, degrees)) + 135) / step)]);
  };
  dial.addEventListener('pointerdown', event => { dragging = true; dial.setPointerCapture(event.pointerId); dial.focus(); fromPointer(event); });
  dial.addEventListener('pointermove', event => { if (dragging) fromPointer(event); });
  dial.addEventListener('pointerup', () => { dragging = false; commit(shown); });
  dial.addEventListener('pointercancel', () => { dragging = false; show(Number(select.value)); });
  dial.addEventListener('wheel', event => { event.preventDefault(); nudge(event.deltaY < 0 ? 1 : -1); }, { passive: false });
  dial.addEventListener('keydown', event => {
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); commit(event.key === 'Home' ? values[0] : values.at(-1)); }
    else if (direction) { event.preventDefault(); nudge(direction); }
  });
  show(shown);
  return value => { if (!dragging && timer === null) show(value); };
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-value]').forEach(choice => choice.setAttribute('aria-pressed', choice.dataset.themeValue === theme));
}

function initializeTheme() {
  applyTheme(state?.theme || 'auto');
  document.querySelectorAll('[data-theme-value]').forEach(choice => choice.addEventListener('click', () => update({ theme: choice.dataset.themeValue })));
}

if (display) {
  if (navigator.locks) navigator.locks.request('argus-display', { ifAvailable: true }, async lock => {
    if (!lock) { report('A TV window is already open. Use that window, or close it and reload this one.'); return; }
    startDisplay();
    await new Promise(() => {});
  });
  else startDisplay();
} else {
  $('#open-display').onclick = () => window.open('/display', 'argus-tv', 'popup,width=1440,height=900');
  $('#grid').onclick = () => focus(null);
  $('#previews').onclick = () => update(current => ({ previews: current.previews === false }));
  $('#youtube-controls').onclick = () => update(current => ({ youtubeControls: current.youtubeControls !== true }));
  $('#enable-tv').onclick = () => update(current => ({ playbackRequest: (current.playbackRequest || 0) + 1 }));
  $('#fullscreen-tv').onclick = () => update(current => ({ fullscreenRequest: (current.fullscreenRequest || 0) + 1 }));
  $('#mute').onclick = () => update({ audio: null });
  $('#count').onchange = event => update({ count: Number(event.target.value) });
  syncDial = setupDial($('#count-dial'), $('#count'), $('#count-readout'));
  $('#volume').onchange = event => update({ volume: Number(event.target.value) });
  $('#follow').onchange = event => update(current => ({ follow: event.target.checked, ...(event.target.checked && current.focus !== null ? { audio: current.focus } : {}) }));
  connect();
}

initializeTheme();
