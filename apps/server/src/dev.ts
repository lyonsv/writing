import { existsSync } from 'node:fs';
import path from 'node:path';

import { createApp } from './app';
import { loadConfig } from './config';
import { storeFromEnv } from './env';
import { listen } from './local';

/**
 * Local dev server: `pnpm dev:server` (no Vercel login needed). Reads
 * `apps/server/.env.local` if present (git-ignored); see `.env.example`.
 * Defaults to the in-memory store, so tokens are forgotten on restart.
 */
const envFile = path.resolve(import.meta.dirname, '../.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.MARGIN_STORE ??= 'memory';
const port = Number(process.env.PORT ?? 3000);

const config = loadConfig();
const app = createApp({ config, store: storeFromEnv() });
const { url } = await listen(app, port);
console.log(`Margin server on ${url} (public URL ${config.publicUrl.origin}, store ${process.env.MARGIN_STORE})`);
