import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:package.');
const folder = await mkdtemp(path.join(tmpdir(), 'argus package '));
let child;
try {
  const runNpm = args => execFileSync(process.execPath, [npm, ...args], { encoding: 'utf8', windowsHide: true });
  const result = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', folder]));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  const allowed = new Set(['package.json', 'README.md', 'RUNBOOK.md', 'cli.mjs', 'server.mjs', 'storage.mjs', 'state.mjs', 'app.js', 'index.html', 'display.html', 'style.css']);
  for (const file of packed.files) assert.ok(allowed.has(file.path), `Unexpected package file: ${file.path}`);
  const installDir = path.join(folder, 'installed');
  runNpm(['install', '--prefix', installDir, path.join(folder, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  const packageDir = path.join(installDir, 'node_modules', packed.name);
  const cli = path.join(packageDir, 'cli.mjs');
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /Usage: argus/);
  child = spawn(process.execPath, [cli, '--port', '0', '--data-dir', path.join(folder, 'user data')], { cwd: tmpdir(), windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 10000);
    child.stdout.on('data', () => { if (output.includes('Controls:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${errors}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  await started;
  const origin = output.match(/Controls: (http:\/\/localhost:\d+)/)[1];
  for (const route of ['/', '/display', '/app.js', '/vendor/hls.min.js', '/vendor/dash.all.min.js']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 100, route);
  }
  const state = await (await fetch(origin + '/api/state')).json();
  assert.ok(state.slots.every(slot => slot.url === '' && slot.name.startsWith('Stream ')));
  const changed = await fetch(origin + '/api/state', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ volume: 37 }) });
  assert.equal(changed.status, 200);
  child.kill();
  await once(child, 'exit');
  child = null;
  console.log('Installed package starts outside its install folder, serves both playback libraries, saves settings and stops cleanly.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  await rm(folder, { recursive: true, force: true });
}
