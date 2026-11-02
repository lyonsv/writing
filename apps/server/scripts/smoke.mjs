#!/usr/bin/env node
/**
 * Post-deploy smoke test for the hosted web app (ADR 0020). Required after
 * every deploy (AGENTS.md):
 *
 *   pnpm --filter @margin/server smoke https://margin-sync.vercel.app
 *   pnpm --filter @margin/server smoke https://<preview>.vercel.app --vercel-curl   # protected preview
 *
 * Signed out, it checks that:
 *   - static files are served (200) with the right content type and caching:
 *     a content-hashed JS bundle (immutable), apple-touch-icon.png, favicon.ico,
 *     manifest.webmanifest, sw.js (no-cache), and that the CDN caches them (x-vercel-cache);
 *   - /, /index.html and /api/me answer 401 (sign-in page / JSON), and the app shell isn't sent;
 *   - no HTML is in the public file list;
 *   - the native sign-in confirm page doesn't send Referrer-Policy: no-referrer
 *     (its form POST would carry Origin: null and fail the CSRF check).
 * `--vercel-curl` sends every request through `vercel curl` (deployment-protection bypass).
 * Exit code 1 on any failure.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [base, ...flags] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error('usage: smoke <deployment url> [--vercel-curl]');
  process.exit(2);
}
const origin = new URL(base).origin;
const viaVercel = flags.includes('--vercel-curl');

/** GET a path; returns status, lower-cased headers and body text. */
async function get(path) {
  if (!viaVercel) {
    const res = await fetch(origin + path, { redirect: 'manual' });
    const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
    return { status: res.status, headers, body: await res.text() };
  }
  const { stdout } = await promisify(execFile)(
    'npx',
    ['--yes', 'vercel@latest', 'curl', path, '--deployment', origin, '--', '-s', '-i', '--max-time', '30'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // Skip any interim responses (100 Continue, HTTP/2 preface) and take the last header block.
  const blocks = stdout.split(/\r?\n\r?\n/);
  let i = 0;
  while (i < blocks.length - 1 && /^HTTP\/\S+ (1\d\d)/.test(blocks[i])) i++;
  const head = blocks[i] ?? '';
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const headers = {};
  for (const l of lines) {
    const k = l.slice(0, l.indexOf(':')).trim().toLowerCase();
    if (k) headers[k] = l.slice(l.indexOf(':') + 1).trim();
  }
  return { status: Number(/HTTP\/\S+ (\d+)/.exec(statusLine ?? '')?.[1] ?? 0), headers, body: blocks.slice(i + 1).join('\n\n') };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const list = await get('/margin-assets.json');
let files = [];
try {
  files = JSON.parse(list.body).files ?? [];
} catch {
  /* reported below */
}
check('GET /margin-assets.json → 200 file list', list.status === 200 && files.length > 0, `status ${list.status}, ${files.length} files`);
check('no HTML in the public file list', files.length > 0 && !files.some((f) => /\.html?$/i.test(f)));

const bundle = files.find((f) => /^\/_expo\/static\/js\/web\/.+-[0-9a-f]{16,}\.js$/.test(f));
check('a content-hashed JS bundle is listed', Boolean(bundle), bundle ?? 'none');

const statics = [
  [bundle, /javascript/, /immutable/],
  ['/apple-touch-icon.png', /^image\/png/, null],
  ['/favicon.ico', /^image\//, null],
  ['/manifest.webmanifest', /manifest\+json|json/, null],
  ['/sw.js', /javascript/, /no-cache/],
];
for (const [path, type, cache] of statics) {
  if (!path) continue;
  const r = await get(path);
  const ct = r.headers['content-type'] ?? '';
  const cc = r.headers['cache-control'] ?? '';
  check(`GET ${path} → 200 ${type}`, r.status === 200 && type.test(ct), `status ${r.status}, ${ct}`);
  if (cache) check(`  cache-control ${cache}`, cache.test(cc), cc || 'none');
  check(`  not the sign-in page`, !r.body.includes('margin-signin'));
}
// The CDN caches static files: a repeat request should be a cache HIT (or STALE/PRERENDER) on Vercel.
if (bundle && /vercel\.app$|\.vercel\.app$/.test(new URL(origin).hostname)) {
  const again = await get(bundle);
  const cache = again.headers['x-vercel-cache'] ?? 'none';
  check(`  CDN caches ${bundle} on repeat`, /HIT|STALE|PRERENDER/i.test(cache), `x-vercel-cache: ${cache}`);
}

for (const path of ['/', '/index.html', '/settings']) {
  const r = await get(path);
  check(`GET ${path} signed out → 401 sign-in page, no app shell`, r.status === 401 && r.body.includes('margin-signin') && !r.body.includes('id="root"'), `status ${r.status}`);
}
// The confirm page must not use no-referrer: browsers would send Origin: null on its form POST
// and the CSRF check would refuse every native sign-in (production bug).
{
  const q = new URLSearchParams({ redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'smoke-test-state-0001', device_name: 'smoke test' });
  const r = await get(`/api/auth/native/start?${q}`);
  const rp = r.headers['referrer-policy'] ?? 'none';
  check('GET the "Sign in a new device?" page → 200, Referrer-Policy not no-referrer', r.status === 200 && !/no-referrer/i.test(rp), `status ${r.status}, referrer-policy: ${rp}`);
}
const me = await get('/api/me');
check('GET /api/me signed out → 401 JSON', me.status === 401 && /unauthorized/.test(me.body), `status ${me.status}`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
