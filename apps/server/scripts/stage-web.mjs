#!/usr/bin/env node
/**
 * Stages the Expo web export for the server function (ADR 0020, amended):
 *   apps/app/dist/index.html → apps/server/web/index.html   the shell; sent only to signed-in browsers
 *   apps/app/dist/** (no HTML) → apps/server/web/assets.json  static files, served publicly by the
 *                                                             function before the auth gate and cached
 *                                                             by Vercel's CDN (CDN-Cache-Control)
 *
 * Why not `public/`: Vercel takes the list of `public/**` files from the
 * *uploaded* source, before the build command runs. Files the build creates
 * there are never deployed (production at 665e581 served none of them), and a
 * placeholder that the build replaces fails the deploy with ENOENT. So the
 * function serves the export itself; both outputs are read via
 * `new URL(..., import.meta.url)` in server.ts, which Vercel's file tracing
 * bundles with the function.
 *
 * No HTML may be served publicly (validator M8): HTML is refused in assets.json.
 * Outputs are git-ignored build artefacts. `public/` is removed if present.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable for tests (test/stageWeb.test.ts).
const dist = path.resolve(process.env.STAGE_WEB_DIST ?? path.join(server, '../app/dist'));
const outRoot = path.resolve(process.env.STAGE_WEB_OUT ?? server);
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('No web export: run pnpm --filter @margin/app export:web first');
const web = path.join(outRoot, 'web');
rmSync(path.join(outRoot, 'public'), { recursive: true, force: true });
rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

const isHtml = (p) => /\.html?$/i.test(p);
const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.join(e.parentPath ?? e.path, e.name));

/** Public path ("/_expo/static/js/web/entry-….js") → base64 bytes. */
const assets = {};
for (const file of files) {
  const rel = `/${path.relative(dist, file).split(path.sep).join('/')}`;
  if (isHtml(rel)) continue;
  assets[rel] = readFileSync(file).toString('base64');
}
// The list of public static paths (names only; the files are public anyway), for the
// post-deploy smoke test (scripts/smoke.mjs) to pick a real hashed bundle.
assets['/margin-assets.json'] = Buffer.from(JSON.stringify({ files: Object.keys(assets).sort() })).toString('base64');
if (Object.keys(assets).some(isHtml)) throw new Error('HTML must not be public');
writeFileSync(path.join(web, 'assets.json'), JSON.stringify(assets));
writeFileSync(path.join(web, 'index.html'), readFileSync(path.join(dist, 'index.html')));
console.log(`staged web app: web/index.html (shell) + web/assets.json (${Object.keys(assets).length} static files)`);
