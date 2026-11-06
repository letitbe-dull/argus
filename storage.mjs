import { homedir } from 'node:os';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initialState, normalizeState } from './state.mjs';

export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Argus');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Argus');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'argus');
}

export function openStorage(dataDir, legacyFile, warn = console.warn) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'settings.json');
  const save = value => {
    const temp = path.join(dataDir, `settings.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  };
  const source = existsSync(file) ? file : legacyFile && existsSync(legacyFile) ? legacyFile : null;
  let state = initialState();
  if (source) {
    let value;
    try {
      value = JSON.parse(readFileSync(source, 'utf8'));
      if (value?.schemaVersion !== undefined && value.schemaVersion !== 1) {
        const error = new Error(`Unsupported settings version ${value.schemaVersion}. Use a newer Argus or choose another data folder.`);
        error.code = 'SETTINGS_VERSION';
        throw error;
      }
      const legacy = source !== file || value.schemaVersion !== 1;
      if (legacy) {
        const backup = path.join(dataDir, `settings.legacy.${randomUUID()}.json`);
        copyFileSync(source, backup);
        warn(`Settings backup: ${backup}`);
        const removed = [];
        value.slots = value.slots.map((slot, id) => {
          if (!['capture', 'server-browser', 'embed'].includes(slot.type)) return slot;
          removed.push(id + 1);
          return { id, name: slot.name, type: 'video', url: '', reload: 0 };
        });
        if (removed.includes(value.audio + 1)) value.audio = null;
        if (removed.length) warn(`Removed capture/website sources ${removed.join(', ')}. Add a YouTube or direct stream URL to use these slots.`);
      }
      state = normalizeState(value);
    } catch (error) {
      if (error.code === 'SETTINGS_VERSION') throw error;
      const backup = path.join(dataDir, `settings.invalid.${randomUUID()}.json`);
      copyFileSync(source, backup);
      warn(`Could not load settings: ${error.message}. Starting with empty sources. Original saved at ${backup}`);
    }
  }
  state = normalizeState(state);
  save(state);
  return { state, save, file };
}
