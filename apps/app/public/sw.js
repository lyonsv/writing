/*
 * Margin's service worker (ADR 0020): an offline app shell, nothing else.
 *
 * - /api/* is never intercepted or cached (documents, tokens and sign-in stay network-only).
 * - Navigations are network-first. A signed-in shell (the server marks it with
 *   X-Margin-Shell: 1) is kept for offline launches. A 401 sign-in page deletes
 *   that copy, so after signing out (or a revoke) the cached shell is never served.
 * - Hashed static files (/_expo/static, /assets) and icons are cache-first;
 *   their names change when their content does.
 */
const SHELL = 'margin-shell-v1';
const ASSETS = 'margin-assets-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('margin-') && key !== SHELL && key !== ASSETS) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'margin:signed-out') event.waitUntil(caches.delete(SHELL));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return; // network only, never cached
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith('/_expo/static/') || url.pathname.startsWith('/assets/') || /\.(png|svg|ico|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function navigate(request) {
  const cache = await caches.open(SHELL);
  let response;
  try {
    response = await fetch(request, { cache: 'no-store' });
  } catch {
    const cached = await cache.match('/');
    return (
      cached ||
      new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>Margin</title><p style="font:16px -apple-system,sans-serif;margin:20vh 2rem">Margin needs to be online the first time, to sign in.</p>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
  if (response.ok && response.headers.get('X-Margin-Shell') === '1') await cache.put('/', response.clone());
  else if (response.status === 401) await cache.delete('/');
  return response;
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
