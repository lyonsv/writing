import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/** Validator M8 LOW: no HTML may reach public/ (the CDN serves it without sign-in). */
const script = path.resolve(import.meta.dirname, '../scripts/stage-web.mjs');
let tmp: string;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function stage(files: Record<string, string>) {
  tmp = mkdtempSync(path.join(tmpdir(), 'margin-stage-'));
  const dist = path.join(tmp, 'dist');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, p)), { recursive: true });
    writeFileSync(path.join(dist, p), text);
  }
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [script], { env: { ...process.env, STAGE_WEB_DIST: dist, STAGE_WEB_OUT: out }, stdio: 'pipe' });
  return out;
}

describe('stage-web', () => {
  it('puts the shell in web/index.html and the static files, never HTML, in web/assets.json', () => {
    const out = stage({
      'index.html': '<html>shell</html>',
      'other.html': '<html>another page</html>',
      'nested/page.htm': '<html>x</html>',
      '_expo/static/js/web/entry.js': 'js',
      'manifest.webmanifest': '{}',
    });
    expect(readFileSync(path.join(out, 'web/index.html'), 'utf8')).toBe('<html>shell</html>');
    const assets = JSON.parse(readFileSync(path.join(out, 'web/assets.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(assets).sort()).toEqual(['/_expo/static/js/web/entry.js', '/manifest.webmanifest', '/margin-assets.json']);
    expect(JSON.parse(Buffer.from(assets['/margin-assets.json']!, 'base64').toString())).toEqual({ files: ['/_expo/static/js/web/entry.js', '/manifest.webmanifest'] });
    expect(Buffer.from(assets['/_expo/static/js/web/entry.js']!, 'base64').toString()).toBe('js');
    expect(existsSync(path.join(out, 'public'))).toBe(false); // Vercel wouldn't deploy it anyway
  });
});
