/*
 * Margin's service worker (ADR 0020): an offline app shell, nothing else.
 *
 * - /api/* is never intercepted or cached (documents, tokens and sign-in stay network-only).
 * - Navigations are network-first. A signed-in shell (the server marks it with
 *   X-Margin-Shell: 1) is kept and shown when the network fails, the server
 *   answers 5xx, or takes over 4 s. A 401/403 sign-in page deletes that copy, so
 *   after signing out (or a revoke) the cached shell is never served.
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

/** How long a navigation may take before a cached shell is shown instead. */
const NAVIGATION_TIMEOUT_MS = 4000;

const offlinePage = () =>
  new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><title>Margin</title><p style="font:16px -apple-system,sans-serif;margin:20vh 2rem">Margin needs to be online the first time, to sign in.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

/**
 * Network first, but a signed-in user is never locked out by the server
 * (validator M8): with a cached shell, a network error, a 5xx or no answer
 * within 4 s shows the cached shell. Only 401/403 (signed out, revoked) delete
 * it, and those are passed through so the sign-in page shows.
 */
async function navigate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match('/');
  const network = fetch(request, { cache: 'no-store' }).then(async (response) => {
    if (response.ok && response.headers.get('X-Margin-Shell') === '1') await cache.put('/', response.clone());
    else if (response.status === 401 || response.status === 403) await cache.delete('/');
    return response;
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  let response = null;
  try {
    response = cached ? await Promise.race([network, timeout]) : await network;
  } catch {
    response = null; // network error
  } finally {
    clearTimeout(timer);
  }
  if (response === null) {
    network.catch(() => undefined); // a late answer still refreshes or deletes the cache
    return cached || offlinePage();
  }
  if (response.status >= 500 && cached) return cached;
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
