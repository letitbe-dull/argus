import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizeState } from './state.mjs';
import { openStorage, defaultDataDir } from './storage.mjs';

const root = new URL('./', import.meta.url);
const files = {
  '/': 'index.html', '/display': 'display.html', '/app.js': 'app.js', '/style.css': 'style.css', '/state.mjs': 'state.mjs',
  '/vendor/hls.min.js': 'node_modules/hls.js/dist/hls.min.js',
  '/vendor/dash.all.min.js': 'node_modules/dashjs/dist/modern/umd/dash.all.min.js'
};

export async function startServer({ port = 8765, dataDir = defaultDataDir(), legacyFile = new URL('settings.json', root), log = console.log, warn = console.warn } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  const storage = openStorage(dataDir, legacyFile, warn);
  let state = { ...storage.state, revision: 0, session: randomUUID() };
  const clients = new Set();
  const statuses = {};
  let origin;
  let allowedHosts;
  let allowedOrigins;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(403).end('Use the printed localhost address.'); return; }
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; }
    catch { res.writeHead(400).end('Invalid URL'); return; }
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      clients.add(res);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify(statuses)}\n\n`);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      res.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && ['/api/state', '/api/status'].includes(pathname)) {
      if (!allowedOrigins.has(req.headers.origin)) { res.writeHead(403).end('Origin rejected.'); return; }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32768) { res.writeHead(413).end('Request too large'); return; }
          chunks.push(chunk);
        }
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a settings object.');
        if (pathname === '/api/status') {
          if (!Number.isInteger(patch.id) || patch.id < 0 || patch.id >= state.count || typeof patch.message !== 'string' || patch.message.length > 1000) throw new Error('Invalid source status.');
          statuses[patch.id] = patch.message;
          broadcast('status', statuses);
          res.writeHead(204).end();
          return;
        }
        const next = { ...normalizeState({ ...state, ...patch }), revision: state.revision + 1, session: state.session };
        try { storage.save(next); }
        catch (error) { warn(`Could not save settings: ${error.message}`); res.writeHead(500).end('Could not save settings. Check the data folder permissions and free space.'); return; }
        for (let id = 0; id < next.slots.length; id++) {
          const key = slot => JSON.stringify([slot.type, slot.url, slot.reload]);
          if (id >= next.count || key(next.slots[id]) !== key(state.slots[id])) delete statuses[id];
        }
        state = next;
        broadcast('', state);
        broadcast('status', statuses);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
      } catch (error) { res.writeHead(400).end(error.message); }
      return;
    }
    if (req.method === 'GET' && Object.hasOwn(files, pathname)) {
      try {
        const file = files[pathname];
        const content = readFileSync(new URL(file, root));
        const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(content);
      } catch { res.writeHead(500).end('An application file is missing. Reinstall Argus.'); }
      return;
    }
    res.writeHead(404).end('Not found');
  });
  function broadcast(event, value) {
    for (const client of clients) client.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      origin = `http://localhost:${actualPort}`;
      allowedOrigins = new Set([origin, `http://127.0.0.1:${actualPort}`]);
      allowedHosts = new Set([...allowedOrigins].map(value => new URL(value).host));
      server.removeListener('error', reject);
      resolve();
    });
  });
  log(`Argus\nControls: ${origin}\nTV view:  ${origin}/display\nSettings: ${storage.file}\nStop with Ctrl+C.`);
  return server;
}
