#!/usr/bin/env node
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { startServer } from './server.mjs';
import { defaultDataDir } from './storage.mjs';

try {
  const options = { port: Number(process.env.PORT || 8765), dataDir: process.env.ARGUS_DATA_DIR || defaultDataDir() };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Argus\nUsage: argus [--port PORT] [--data-dir FOLDER] [--import SETTINGS.json]\n\nOpen the printed controls URL in your browser. Stop with Ctrl+C.\n--version  Print version\n--help     Show this help');
      process.exit(0);
    }
    if (arg === '--version') {
      console.log(JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version);
      process.exit(0);
    }
    if (!['--port', '--data-dir', '--import'].includes(arg)) throw new Error(`Unknown option: ${arg}. Use --help.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--port') options.port = Number(value);
    else if (arg === '--data-dir') options.dataDir = path.resolve(value);
    else options.legacyFile = path.resolve(value);
  }
  if (options.legacyFile) {
    readFileSync(options.legacyFile);
    if (existsSync(path.join(options.dataDir, 'settings.json'))) throw new Error('Import needs an empty data folder. Use --data-dir to choose a new folder.');
  }
  const server = await startServer(options);
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`Argus: ${error.code === 'EADDRINUSE' ? 'Port is already in use. Choose another with --port.' : error.message}`);
  process.exitCode = 1;
}
