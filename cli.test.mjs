import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, copyFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cli = new URL('cli.mjs', import.meta.url);
const cliPath = fileURLToPath(cli);

test('CLI explains usage and rejects invalid options before startup', () => {
  for (const args of [['--help'], ['--version']]) assert.equal(spawnSync(process.execPath, [cliPath, ...args]).status, 0);
  for (const args of [['--port', 'bad'], ['--port', '65536'], ['--data-dir'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Argus:/);
    assert.doesNotMatch(result.stderr, /at .*\.mjs:/);
  }
});

test('CLI runs outside its installation with a spaced data path and exits with connected windows', { timeout: 10000 }, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'argus cli '));
  const installDir = path.join(folder, 'application');
  await mkdir(installDir);
  for (const file of ['cli.mjs', 'server.mjs', 'storage.mjs', 'state.mjs', 'package.json', 'index.html', 'display.html', 'app.js', 'style.css']) await copyFile(new URL(file, import.meta.url), path.join(installDir, file));
  const dataDir = path.join(folder, 'user data');
  const child = spawn(process.execPath, [path.join(installDir, 'cli.mjs'), '--port', '0', '--data-dir', dataDir], { cwd: tmpdir(), windowsHide: true });
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(folder, { recursive: true, force: true });
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Controls:')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Startup failed ${code}: ${errors}`)));
  });
  const origin = output.match(/Controls: (http:\/\/localhost:\d+)/)[1];
  assert.equal((await fetch(origin)).status, 200);
  const state = await (await fetch(origin + '/api/state')).json();
  assert.ok(state.slots.every(slot => slot.url === ''));
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).schemaVersion, 1);
  const events = await fetch(origin + '/events', { signal: abort.signal });
  assert.equal(events.status, 200);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
});
