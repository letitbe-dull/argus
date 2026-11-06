import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { request } from 'node:http';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'argus-'));
  const server = await startServer({ port: 0, dataDir, legacyFile: null, log() {}, warn() {} });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = (route, value, headers = {}) => fetch(origin + route, { method: 'POST', headers: { Origin: origin, ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value) });
  return { server, origin, dataDir, post };
}

async function readEvent(reader, type = 'message', matches = () => true) {
  let buffer = reader.buffer || '';
  for (;;) {
    const end = buffer.indexOf('\n\n');
    if (end >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const eventType = frame.split('\n').find(line => line.startsWith('event:'))?.slice(7) || 'message';
      const data = frame.split('\n').find(line => line.startsWith('data:'))?.slice(6);
      if (eventType === type && data && matches(JSON.parse(data))) { reader.buffer = buffer; return JSON.parse(data); }
    } else {
      const { value, done } = await reader.read();
      if (done) throw new Error('Event stream ended');
      buffer += new TextDecoder().decode(value);
    }
  }
}

test('local windows synchronize state and status, persist settings and survive reconnects', { timeout: 10000 }, async t => {
  const { server, origin, dataDir, post } = await setup(t);
  assert.equal(server.address().address, '127.0.0.1');
  const abort = new AbortController();
  t.after(() => abort.abort());
  const readers = [];
  for (let i = 0; i < 2; i++) readers.push((await fetch(origin + '/events', { signal: abort.signal })).body.getReader());
  for (const reader of readers) assert.equal((await readEvent(reader)).count, 4);
  const order = [11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const saved = await post('/api/state', { count: 12, order, focus: 11, audio: 11, theme: 'dark' });
  assert.equal(saved.status, 200);
  for (const reader of readers) {
    const state = await readEvent(reader);
    assert.equal(state.audio, 11);
    assert.equal(state.focus, 11);
    assert.equal(state.theme, 'dark');
    assert.deepEqual(state.order, order);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).order, order);
  assert.equal((await post('/api/status', { id: 11, message: 'Playing' })).status, 204);
  for (const reader of readers) assert.equal((await readEvent(reader, 'status', value => value[11] === 'Playing'))[11], 'Playing');
  const third = (await fetch(origin + '/events', { signal: abort.signal })).body.getReader();
  assert.equal((await readEvent(third)).audio, 11);
  assert.equal((await readEvent(third, 'status'))[11], 'Playing');
  const restarted = await startServer({ port: 0, dataDir, legacyFile: null, log() {} });
  try {
    const state = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/state`)).json();
    assert.equal(state.audio, 11);
    assert.deepEqual(state.order, order);
    assert.notEqual(state.session, (await saved.json()).session);
  } finally { restarted.closeAllConnections(); await new Promise(resolve => restarted.close(resolve)); }
  abort.abort();
});

test('local API rejects invalid origins, hosts, payloads and removed browser routes', async t => {
  const { origin, post } = await setup(t);
  assert.equal((await post('/api/state', { count: 4 }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/state', { count: 4 }, { Origin: '' })).status, 403);
  for (const value of ['{', 'null', '[]', '{"volume":200}', '{"slots":[]}']) assert.equal((await post('/api/state', value)).status, 400);
  assert.equal((await post('/api/state', ' '.repeat(32769))).status, 413);
  assert.equal((await post('/api/status', { id: 12, message: 'Playing' })).status, 400);
  const status = await new Promise((resolve, reject) => {
    const req = request(origin, { headers: { Host: 'untrusted.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  for (const route of ['/settings.json', '/storage.mjs', '/package.json', '/api/browsers', '/browser/1/index.m3u8', '/browser-control/1/vnc.html', '/toString']) assert.equal((await fetch(origin + route)).status, 404);
  assert.equal((await post('/api/browser', { id: 0, action: 'start' })).status, 404);
  for (const route of ['/', '/display', '/app.js', '/state.mjs', '/style.css']) assert.equal((await fetch(origin + route)).status, 200);
});

test('failed persistence leaves the running state unchanged', async t => {
  const { origin, dataDir, post } = await setup(t);
  await rename(path.join(dataDir, 'settings.json'), path.join(dataDir, 'original.json'));
  await mkdir(path.join(dataDir, 'settings.json'));
  assert.equal((await post('/api/state', { volume: 25 })).status, 500);
  assert.equal((await (await fetch(origin + '/api/state')).json()).volume, 80);
});

test('port conflicts produce a startup error', async t => {
  const { server, dataDir } = await setup(t);
  await assert.rejects(startServer({ port: server.address().port, dataDir, legacyFile: null, log() {} }), { code: 'EADDRINUSE' });
});
