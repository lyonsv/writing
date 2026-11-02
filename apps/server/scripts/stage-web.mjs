#!/usr/bin/env node
/**
 * Stages the Expo web export for Vercel (ADR 0020):
 *   apps/app/dist/**           → apps/server/public/**   (static, served by Vercel's CDN; no user data)
 *   apps/app/dist/index.html   → apps/server/web/index.html (the shell; sent only to signed-in browsers by server.ts)
 * No HTML may be in public/: the CDN would serve it without sign-in (validator M8:
 * not just index.html; any *.html could be a shell or carry inline script).
 * Both outputs are git-ignored build artefacts.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable for tests (test/stageWeb.test.ts).
const dist = path.resolve(process.env.STAGE_WEB_DIST ?? path.join(server, '../app/dist'));
const outRoot = path.resolve(process.env.STAGE_WEB_OUT ?? server);
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('No web export: run pnpm --filter @margin/app export:web first');
const pub = path.join(outRoot, 'public');
const web = path.join(outRoot, 'web');
rmSync(pub, { recursive: true, force: true });
rmSync(web, { recursive: true, force: true });
const isHtml = (p) => /\.html?$/i.test(p);
cpSync(dist, pub, { recursive: true, filter: (src) => !isHtml(src) });
mkdirSync(web, { recursive: true });
cpSync(path.join(dist, 'index.html'), path.join(web, 'index.html'));
/** Every file under `dir`, recursively. */
export function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}
const leaked = listFiles(pub).filter(isHtml);
if (leaked.length) throw new Error(`HTML must not be public (served without sign-in): ${leaked.map((f) => path.relative(pub, f)).join(', ')}`);
console.log('staged web app: public/ (static) + web/index.html (shell)');
