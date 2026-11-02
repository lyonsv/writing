import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  it('puts the shell in web/ and no HTML at all in public/', () => {
    const out = stage({
      'index.html': '<html>shell</html>',
      'other.html': '<html>another page</html>',
      'nested/page.htm': '<html>x</html>',
      '_expo/static/js/web/entry.js': 'js',
      'manifest.webmanifest': '{}',
    });
    expect(existsSync(path.join(out, 'web/index.html'))).toBe(true);
    const pub = readdirSync(path.join(out, 'public'), { recursive: true }).map(String);
    expect(pub.filter((f) => /\.html?$/i.test(f))).toEqual([]);
    expect(pub).toContain(path.join('_expo', 'static', 'js', 'web', 'entry.js'));
  });
});
