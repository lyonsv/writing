import { createApp } from './app';
import { loadConfig } from './config';
import { storeFromEnv } from './env';

/**
 * Vercel entry point (zero-config Hono, Node.js runtime, Fluid Compute; see
 * ADR 0010 and vercel.json). Config is loaded lazily on the first request; if it
 * is incomplete every request gets a generic 500 rather than an unauthenticated
 * server.
 */
const app = createApp({ config: loadConfig, store: storeFromEnv() });

export default app;
