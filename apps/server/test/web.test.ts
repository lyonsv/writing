import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SHELL_CSP } from '../src/createApp';
import { assetsFromJson, webDir } from '../src/webFiles';
import { Jar, OWNER, setup } from './helpers';

/** The hosted web app on the API's origin (ADR 0020). */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'margin-web-'));
  mkdirSync(path.join(dir, '_expo/static/js/web'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Margin</title></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(dir, '_expo/static/js/web/entry-abc.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'sw.js'), '// sw');
  writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function webSignIn(h: ReturnType<typeof setup>) {
  const jar = new Jar();
  const start = await h.req('/api/auth/web/start?return_to=/');
  jar.absorb(start);
  const { code, state } = h.github.approve(start.headers.get('Location')!, OWNER);
  jar.absorb(await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, { headers: { Cookie: jar.header() } }));
  return jar;
}

describe('hosted web app', () => {
  it('signed out: every page is the sign-in page (401, no app shell), and the API still answers JSON', async () => {
    const h = setup({ web: webDir(dir) });
    for (const p of ['/', '/editor', '/index.html', '/some/deep/path']) {
      const res = await h.req(p);
      expect(res.status, p).toBe(401);
      const html = await res.text();
      expect(html).toContain('Sign in with GitHub');
      expect(html).not.toContain('id="root"');
      expect(res.headers.get('X-Margin-Shell')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    const link = /href="([^"]+)"/.exec(await (await h.req('/editor')).text().then((t) => t.replace(/<link[^>]*>/g, '')))![1]!;
    expect(link.replace(/&amp;/g, '&')).toBe('/api/auth/web/start?return_to=%2Feditor');
    const api = await h.req('/api/me');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'unauthorized' });
  });

  it('signed in: the shell, marked for the service worker, with its CSP and the hosted marker', async () => {
    const h = setup({ web: webDir(dir) });
    const jar = await webSignIn(h);
    const res = await h.req('/editor', { headers: { Cookie: jar.header() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Margin-Shell')).toBe('1');
    expect(res.headers.get('Content-Security-Policy')).toBe(SHELL_CSP);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('<meta name="margin-hosted" content="1">');
    // Unknown API paths stay JSON 404s, not the shell.
    expect((await h.req('/api/nope', { headers: { Cookie: jar.header() } })).status).toBe(404);
  });

  it('static files are public (no user data); the shell and paths outside the export are not', async () => {
    const h = setup({ web: webDir(dir) });
    const js = await h.req('/_expo/static/js/web/entry-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('Cache-Control')).toContain('immutable');
    const sw = await h.req('/sw.js');
    expect(sw.headers.get('Cache-Control')).toBe('no-cache');
    expect(sw.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    for (const p of ['/index.html', '/..%2Fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/_expo/../index.html']) {
      const res = await h.req(p);
      expect(res.status, p).toBe(401); // sign-in page, never a file
    }
  });

  it('cookie-authenticated writes need our Origin (CSRF)', async () => {
    const h = setup({ web: webDir(dir) });
    const jar = await webSignIn(h);
    const put = (origin?: string) =>
      h.req('/api/sync/file?path=a.md', {
        method: 'PUT',
        headers: { Cookie: jar.header(), 'If-None-Match': '*', 'Content-Type': 'application/octet-stream', ...(origin ? { Origin: origin } : {}) },
        body: 'x',
      });
    expect((await put()).status).toBe(403);
    expect((await put('https://evil.example')).status).toBe(403);
    expect((await put('https://margin.test')).status).toBe(200);
  });

  it('without a web build the server is API-only (no catch-all)', async () => {
    const h = setup();
    expect((await h.req('/')).headers.get('Content-Type')).toContain('application/json');
  });

  it('on Vercel: static files come from the staged assets.json, publicly, CDN-cacheable; never HTML', async () => {
    const file = path.join(dir, 'assets.json');
    writeFileSync(
      file,
      JSON.stringify({
        '/_expo/static/js/web/entry-0123456789abcdef.js': Buffer.from('console.log(1)').toString('base64'),
        '/manifest.webmanifest': Buffer.from('{}').toString('base64'),
        '/sneaky.html': Buffer.from('<html>').toString('base64'),
      }),
    );
    const h = setup({ web: { shell: async () => '<html><head></head><body><div id="root"></div></body></html>', asset: assetsFromJson(file) } });
    const js = await h.req('/_expo/static/js/web/entry-0123456789abcdef.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toBe('console.log(1)');
    expect(js.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('CDN-Cache-Control')).toBe('public, max-age=31536000, immutable');
    const manifest = await h.req('/manifest.webmanifest');
    expect(manifest.headers.get('Content-Type')).toBe('application/manifest+json');
    expect(manifest.headers.get('CDN-Cache-Control')).toBe('public, max-age=300');
    expect((await h.req('/sneaky.html')).status).toBe(401); // HTML is never served as a static file
    expect((await h.req('/')).status).toBe(401);
  });
});
