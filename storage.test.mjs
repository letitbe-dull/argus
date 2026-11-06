import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStorage, defaultDataDir } from './storage.mjs';
import { initialState, normalizeState } from './state.mjs';

function folder(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'argus settings '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('data folders follow Windows, macOS and Linux conventions', () => {
  assert.equal(defaultDataDir('win32', { APPDATA: 'roaming' }, 'home'), path.join('roaming', 'Argus'));
  assert.equal(defaultDataDir('win32', {}, 'home'), path.join('home', 'AppData', 'Roaming', 'Argus'));
  assert.equal(defaultDataDir('darwin', {}, 'home'), path.join('home', 'Library', 'Application Support', 'Argus'));
  assert.equal(defaultDataDir('linux', {}, 'home'), path.join('home', '.config', 'argus'));
  assert.equal(defaultDataDir('linux', { XDG_CONFIG_HOME: 'config' }, 'home'), path.join('config', 'argus'));
});

test('settings persist outside the install folder and reload without migrations', t => {
  const dir = folder(t);
  const store = openStorage(dir, null);
  assert.ok(store.state.slots.every(slot => !slot.url && slot.name.startsWith('Stream ')));
  store.save(normalizeState({ ...store.state, volume: 35 }));
  assert.equal(openStorage(dir, null).state.volume, 35);
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});

test('migration backs up original settings and clears unsupported sources without losing supported URLs', t => {
  const dir = folder(t);
  const legacyFile = path.join(dir, 'old.json');
  const legacy = initialState();
  legacy.slots[0] = { ...legacy.slots[0], type: 'youtube', url: 'https://youtu.be/abcdefghijk' };
  for (const [index, type] of ['capture', 'embed', 'server-browser'].entries()) legacy.slots[index + 1] = { ...legacy.slots[index + 1], type, url: 'https://example.com/player' };
  legacy.audio = 2;
  const original = JSON.stringify(legacy);
  writeFileSync(legacyFile, original);
  const messages = [];
  const store = openStorage(dir, legacyFile, value => messages.push(value));
  assert.equal(store.state.slots[0].url, legacy.slots[0].url);
  assert.ok(store.state.slots.slice(1, 4).every(slot => slot.type === 'video' && slot.url === ''));
  assert.equal(store.state.audio, null);
  assert.equal(readFileSync(legacyFile, 'utf8'), original);
  const backup = readdirSync(dir).find(name => name.startsWith('settings.legacy.'));
  assert.equal(readFileSync(path.join(dir, backup), 'utf8'), original);
  assert.ok(messages.some(value => value.includes('2, 3, 4')));
  store.save({ ...store.state, volume: 20 });
  assert.equal(openStorage(dir, legacyFile).state.volume, 20);
});

test('damaged settings are backed up before creating usable defaults', t => {
  const dir = folder(t);
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{broken');
  assert.equal(openStorage(dir, null, () => {}).state.count, 4);
  const backup = readdirSync(dir).find(name => name.startsWith('settings.invalid.'));
  assert.equal(readFileSync(path.join(dir, backup), 'utf8'), '{broken');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1);
});

test('a newer settings format is never overwritten by an older app', t => {
  const dir = folder(t);
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify({ schemaVersion: 2, custom: true });
  writeFileSync(file, original);
  assert.throws(() => openStorage(dir, null), /Unsupported settings version/);
  assert.equal(readFileSync(file, 'utf8'), original);
});
