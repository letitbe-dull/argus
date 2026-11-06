export const names = Array.from({ length: 12 }, (_, id) => `Stream ${id + 1}`);
export function initialState() {
  return { count: 4, order: names.map((_, id) => id), focus: null, audio: null, follow: true, volume: 80, theme: 'auto', previews: true, youtubeControls: false, playbackRequest: 0, fullscreenRequest: 0, slots: names.map((name, id) => ({ id, name, type: 'video', url: '', reload: 0 })) };
}
export function youtubeId(input) {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname === 'youtu.be') return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) return null;
    const id = url.searchParams.get('v') || url.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{11})(?:\/|$)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
export function normalizeState(value) {
  if (!Number.isInteger(value.count) || value.count < 4 || value.count > 12) throw new Error('Choose between four and twelve streams.');
  if (!Array.isArray(value.slots) || ![6, 12].includes(value.slots.length)) throw new Error('Twelve source slots are required.');
  const expanded = [...value.slots, ...initialState().slots.slice(value.slots.length)];
  const slots = expanded.map((slot, id) => {
    if (!['youtube', 'video', 'hls', 'dash'].includes(slot.type)) throw new Error('Unsupported source type.');
    const raw = String(slot.url || '').trim();
    const type = slot.type;
    const url = raw;
    if (type === 'youtube' && url && !youtubeId(url)) throw new Error('Paste a YouTube video/live URL, not a channel URL.');
    if (type !== 'youtube' && url && !(type === 'video' && youtubeId(url))) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('Use a valid http or https source URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http or https source URL.');
    }
    return { id, name: String(slot.name || `Stream ${id + 1}`).slice(0, 60), type, url, reload: Number.isSafeInteger(slot.reload) ? slot.reload : 0 };
  });
  const selected = id => Number.isInteger(id) && id >= 0 && id < value.count ? id : null;
  const focus = selected(value.focus);
  const follow = Boolean(value.follow);
  const volume = Number(value.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('Volume must be 0–100.');
  const theme = value.theme || 'auto';
  if (!['auto', 'light', 'dark'].includes(theme)) throw new Error('Choose System, Light, or Dark.');
  const audio = selected(value.audio);
  const settingsTarget = selected(value.youtubeSettings);
  const youtubeSettings = settingsTarget !== null && settingsTarget === focus && slots[settingsTarget].url && sourceKind(slots[settingsTarget]) === 'youtube' ? settingsTarget : null;
  const counter = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
  const order = value.order ?? initialState().order;
  if (!Array.isArray(order) || order.length !== 12 || new Set(order).size !== 12 || !order.every(id => Number.isInteger(id) && id >= 0 && id < 12)) throw new Error('Stream order must contain each source once.');
  return { schemaVersion: 1, count: value.count, order: [...order], focus, audio, follow, volume, slots, theme, youtubeSettings, previews: value.previews !== false, youtubeControls: value.youtubeControls === true, playbackRequest: counter('playbackRequest'), fullscreenRequest: counter('fullscreenRequest') };
}

export function sourceKind(slot) {
  if (slot.type !== 'video') return slot.type;
  if (youtubeId(slot.url)) return 'youtube';
  const path = new URL(slot.url).pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'video';
}
