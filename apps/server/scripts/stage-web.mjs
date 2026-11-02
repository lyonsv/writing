#!/usr/bin/env node
/**
 * Stages the Expo web export for Vercel (ADR 0020):
 *   apps/app/dist/**           → apps/server/public/**   (static, served by Vercel's CDN; no user data)
 *   apps/app/dist/index.html   → apps/server/web/index.html (the shell; sent only to signed-in browsers by server.ts)
 * index.html must never be in public/, or the CDN would serve it without sign-in.
 * Both outputs are git-ignored build artefacts.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(server, '../app/dist');
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('No web export: run pnpm --filter @margin/app export:web first');
const pub = path.join(server, 'public');
const web = path.join(server, 'web');
rmSync(pub, { recursive: true, force: true });
rmSync(web, { recursive: true, force: true });
cpSync(dist, pub, { recursive: true, filter: (src) => path.relative(dist, src) !== 'index.html' });
mkdirSync(web, { recursive: true });
cpSync(path.join(dist, 'index.html'), path.join(web, 'index.html'));
if (existsSync(path.join(pub, 'index.html'))) throw new Error('index.html leaked into public/');
console.log('staged web app: public/ (static) + web/index.html (shell)');
