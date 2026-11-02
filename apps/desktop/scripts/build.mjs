// Bundles the Electron main and preload scripts into dist/ as single CJS files.
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('esbuild').BuildOptions} */
export const options = {
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
};

export async function watch() {
  const ctx = await context(options);
  await ctx.watch();
  return ctx;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(options);
}
