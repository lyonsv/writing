import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { WebAsset } from './createApp.js';

/**
 * The web app's files from a directory (an Expo web export), for `pnpm
 * dev:server` and tests (ADR 0020). On Vercel the CDN serves the static files
 * from `public/`, and `server.ts` reads only the shell.
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
          type: TYPES[path.extname(file)] ?? 'application/octet-stream',
          immutable: rel.startsWith('/_expo/static/') || rel.startsWith('/assets/'),
        };
      } catch {
        return null;
      }
    },
  };
}
