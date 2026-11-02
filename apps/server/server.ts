import { Hono } from 'hono';

import { createApp } from './src/createApp.js';
import { loadConfig } from './src/config.js';
import { storeFromEnv } from './src/env.js';

/**
 * Vercel entry point (zero-config Hono, Node.js runtime, Fluid Compute; ADR 0014).
 * It lives at the package root because Vercel's entrypoint search tries
 * `server.ts` before `src/app.ts` (which is the app *factory*, not an app).
 * Config is loaded lazily on the first request; if it is incomplete every
 * request gets a generic 500 rather than an unauthenticated server.
 */
const app = createApp({ config: loadConfig, store: storeFromEnv() });

// Vercel's zero-config detection only accepts an entry file that imports `hono`
// itself ("No entrypoint found which imports hono"); this check is that import.
if (!(app instanceof Hono)) throw new Error('createApp must return a Hono app');

export default app;
