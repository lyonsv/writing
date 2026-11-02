import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { WebAsset } from './createApp.js';

/**
 * The web app's files (ADR 0020): from a directory (an Expo web export) for
 * `pnpm dev:server` and tests, or from the staged `web/assets.json` on Vercel
 * (`scripts/stage-web.mjs`), where the function serves them and the CDN caches them.
 */
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export async function readShell(file: string | URL): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

const typeOf = (p: string) => TYPES[path.extname(p)] ?? 'application/octet-stream';
const isImmutable = (p: string) => p.startsWith('/_expo/static/') || p.startsWith('/assets/');

/**
 * Static files from the staged `web/assets.json` (path → base64), read once.
 * Never HTML (the staging refuses it; checked again here).
 */
export function assetsFromJson(file: string | URL): (pathname: string) => Promise<WebAsset | null> {
  let table: Promise<Map<string, Uint8Array>> | undefined;
  const load = async () => {
    const out = new Map<string, Uint8Array>();
    try {
      const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
      for (const [p, b64] of Object.entries(json)) if (!/\.html?$/i.test(p)) out.set(p, new Uint8Array(Buffer.from(b64, 'base64')));
    } catch {
      /* no web build staged: API only */
    }
    return out;
  };
  return async (pathname) => {
    table ??= load();
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const body = (await table).get(rel);
    return body ? { body, type: typeOf(rel), immutable: isImmutable(rel) } : null;
  };
}

export function webDir(dir: string) {
  const root = path.resolve(dir);
  return {
    shell: () => readShell(path.join(root, 'index.html')),
    async asset(pathname: string): Promise<WebAsset | null> {
      let rel: string;
      try {
        rel = decodeURIComponent(pathname);
      } catch {
        return null;
      }
      const file = path.resolve(root, `.${rel}`);
      // Inside the export only; never the shell (that one is behind sign-in).
      if (!file.startsWith(`${root}${path.sep}`) || path.basename(file) === 'index.html') return null;
      try {
        if (!(await stat(file)).isFile()) return null;
        return {
          body: new Uint8Array(await readFile(file)),
          type: typeOf(file),
          immutable: isImmutable(rel),
        };
      } catch {
        return null;
      }
    },
  };
}
