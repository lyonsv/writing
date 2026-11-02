import { Hono } from 'hono';

import { createApp } from './src/createApp.js';
import { loadConfig } from './src/config.js';
import { storeFromEnv } from './src/env.js';
import { readShell } from './src/webFiles.js';

/**
 * Vercel entry point (zero-config Hono, Node.js runtime, Fluid Compute; ADR 0014).
 * It lives at the package root because Vercel's entrypoint search tries
 * `server.ts` before `src/app.ts` (which is the app *factory*, not an app).
 * Config is loaded lazily on the first request; if it is incomplete every
 * request gets a generic 500 rather than an unauthenticated server.
 */
// The hosted web app (ADR 0020): static files are in `public/` (served by Vercel's CDN);
// the HTML shell is read here, so it is only ever sent to a signed-in browser.
// Both are produced by `pnpm --filter @margin/server build:web` (scripts/stage-web.mjs).
const shellFile = new URL('./web/index.html', import.meta.url);
let shell: Promise<string | null> | undefined;
const app = createApp({ config: loadConfig, store: storeFromEnv(), web: { shell: () => (shell ??= readShell(shellFile)) } });

// Vercel's zero-config detection only accepts an entry file that imports `hono`
// itself ("No entrypoint found which imports hono"); this check is that import.
if (!(app instanceof Hono)) throw new Error('createApp must return a Hono app');

export default app;
