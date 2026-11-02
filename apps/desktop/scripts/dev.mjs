// `pnpm dev:desktop`: start the Expo web dev server, bundle main/preload in
// watch mode, then launch Electron pointed at the dev server.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { options } from './build.mjs';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.MARGIN_DEV_PORT ?? '8081';
const devUrl = `http://localhost:${port}`;
const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitFor(url, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await build({ ...options, logLevel: 'warning' });

run('pnpm', ['--filter', '@margin/app', 'exec', 'expo', 'start', '--web', '--port', port], {
  cwd: path.resolve(root, '../..'),
  env: { ...process.env, BROWSER: 'none', CI: process.env.CI ?? '' },
});

console.log(`Waiting for Expo web dev server at ${devUrl} ...`);
await waitFor(devUrl);

const electronBin = createRequire(import.meta.url)('electron');
const electron = run(electronBin, ['.'], {
  cwd: root,
  env: { ...process.env, MARGIN_DEV_SERVER_URL: devUrl },
});
electron.on('exit', (code) => shutdown(code ?? 0));
