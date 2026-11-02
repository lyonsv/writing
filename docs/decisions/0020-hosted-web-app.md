# 0020. The hosted web app: same-origin shell behind sign-in, IndexedDB library, web sync, PWA

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR 0019 (mobile = installable web app), 0010 (cookie session), 0013 (sync), 0014 (Vercel), 0015 (iOS library semantics), 0016 (phone screens).

## Context
ADR 0019 makes the web build the iPhone app. It must be served by the owner's server, work offline once installed, keep documents safe in the browser, and sync with the Mac. The desktop app runs the same web bundle inside Electron and must keep using real files.

## Decision

### Hosting (same origin as the API)
- `https://margin-sync.vercel.app/` serves the app and `/api/*` the API, from the **same Vercel project and function**. Same origin means the existing `__Host-margin_session` cookie (HttpOnly, Secure, SameSite=Lax) authenticates the app's API calls with no CORS and no token in JavaScript.
- **The HTML shell is behind sign-in.** `apps/server` gets the shell from `web/index.html` (read by `server.ts`). After the one auth gate (`requireAuth`), `GET *` (non-`/api`) returns it with `X-Margin-Shell: 1`, `<meta name="margin-hosted">` and its own CSP (`SHELL_CSP`: scripts and connections `'self'` only). **A signed-out page request gets a minimal sign-in page as the gate's 401 response** (no new `PUBLIC_ROUTES` entry), linking to `/api/auth/web/start?return_to=<path>`. API paths keep answering JSON 401.
- **Static files are public:** the hashed JS, fonts, icons, manifest and service worker contain no user data. On Vercel they're in `apps/server/public/` and served by the CDN; `index.html` is never placed there (`scripts/stage-web.mjs` refuses). `vercel.json` sets `buildCommand: pnpm run build:web` (Expo web export, then staging) and cache headers (immutable for `/_expo/static` and `/assets`, `no-cache` for `/sw.js`). Locally and in tests, `webDir()` serves the same files from `apps/app/dist`.
- **To confirm on the first deploy:** that the Hono preset serves `public/**` from the CDN, and that file tracing bundles `web/index.html` with the function (`new URL('./web/index.html', import.meta.url)`). If either fails, the shell route answers 404 and the API is unaffected.

### Library in the browser: IndexedDB through the iOS library
- `IdbFs` (`apps/app/src/web/idbFs.ts`) implements `NativeFs` on one IndexedDB object store, so the browser runs **the same `NativeLibrary` as iOS**. That gives the per-path queue, coalesced saves, no-overwrite create and rename, conflict copies, Recently Deleted (30 days), the core path rules and the sync guards.
- **Every `NativeFs` operation is a single IndexedDB transaction.** A write replaces a file atomically, and a move checks the target and moves a whole folder subtree all-or-nothing. IndexedDB serialises overlapping read-write transactions across tabs, so the no-replace guarantee holds even with two tabs open. Timestamps carry a random sub-millisecond part, so (size, mtime) never repeats between writers.
- **IndexedDB over OPFS:** on iOS, OPFS writes from the page need `createWritable()` (only in recent Safari), sync access handles are worker-only, and there's no multi-file transaction, so folder moves and exclusive creates would need our own journal. IndexedDB is in every iOS Safari that can install a web app.
- `navigator.storage.persist()` is requested at start (granted to home-screen apps on iOS). The M1–M7 localStorage library is **migrated once, create-only**; the old blob is kept as `margin.library.v1.migrated` rather than deleted.
- **Runtime choice** (`documentStore.web.ts`): Electron (preload bridge present) → real files in the main process, unchanged; otherwise → IndexedDB. Settings stay in localStorage (not documents).

### Web sync
- The core engine and the shared `HttpSyncRemote` run in the browser (`NativeSyncService`, as on iOS) over `WebAccount.request`: same-origin `fetch` with `credentials: 'same-origin'`, `redirect: 'error'` and `cache: 'no-store'`. A 401 means signed out (revoked or expired).
- **CSRF:** every state-changing API route needs `Origin` = `PUBLIC_URL` for cookie-authenticated requests (ADR 0010; tested for sync PUT), and SameSite=Lax withholds the cookie cross-site.
- **When:** at start, when the page becomes visible, every 60 s while visible, 3 s after edits, and on the library's **Sync** button. react-native-web has no `RefreshControl`, so there's no pull-to-refresh on the web.
- **Flushing:** the editor flushes on `pagehide`, `visibilitychange` (hidden) and blur; the workspace flushes on `pagehide` and when the page is hidden.
- The last known identity (login, device id; not secrets) is remembered, so the app works offline as signed in and syncs when the network returns.

### PWA
- `apps/app/public/index.html` (Expo's HTML template) adds `manifest.webmanifest` (standalone, theme colours, M7 icons including maskable), `apple-touch-icon`, `apple-mobile-web-app-capable`, the status-bar style and `viewport-fit=cover`, and stops the page from scrolling or bouncing.
- **Service worker** (`public/sw.js`), registered only when hosted (never in Electron or `pnpm dev:web`):
  - **never intercepts `/api/*`**;
  - navigations are network-first; it caches a shell only if the server marked it `X-Margin-Shell: 1` (signed in), and serves that only when offline;
  - a 401 sign-in page **deletes** the cached shell, and so does sign-out (from the page as well);
  - hashed assets are cache-first.
- **Phone layout:** a phone-sized browser outside Electron gets the **M6 phone screens** (Library, Editor, Settings, `components/phone/`), shared with iOS through a small navigation and services context. Wider windows get the desktop workspace.
  - **Keyboard:** iOS Safari shrinks only the visual viewport, so `useKeyboardOverlap.web.ts` derives the overlap from `visualViewport` and undoes Safari's page scroll. The editor then sits above the keyboard, its scroller keeps the caret visible, and typewriter mode re-centres on the resize (ADR 0016).
  - Safe areas come from `env(safe-area-inset-*)` via react-native-safe-area-context.

## Consequences
- **Tests:**
  - `apps/app/test/idb.test.ts`: `IdbFs` contract on fake-indexeddb, the library on IndexedDB, migration.
  - `apps/server/test/web.test.ts`: sign-in page vs shell, headers, static files, traversal, CSRF.
  - `e2e/web/pwa.spec.ts` (**WebKit, iPhone 15 profile**, local server, mock GitHub): sign-in through the page; welcome document synced; IndexedDB persistence across reloads; an offline edit synced after reconnecting; convergence with the **real desktop sync client** (bundled with esbuild, run as a child process); the service worker controlling the page, caching no `/api` response, opening offline, and serving neither the shell after sign-out nor offline.
- **Not verified on an iPhone:** the Safari home-screen install, storage persistence and eviction behaviour, the keyboard and `visualViewport` behaviour, and OAuth inside a standalone web app (iOS may open GitHub in an in-app sheet). See `docs/ios-testing.md`.
- **Multi-tab:** two tabs each run sync (CAS and hash guards keep them safe), and an edit in one tab isn't pushed live to another tab's open editor. A later save there goes to a conflict copy, never over the other tab's text.

## Amendments (2026-11-02, validator review of eed0a76)
- **Two tabs and a sync download (MEDIUM).** The library compared the hash and wrote in separate IndexedDB transactions, and its per-path queue only exists within one tab. So tab A's download could overwrite a save that tab B had just reported as saved. Now:
  - `NativeFs` has optional `writeIf` / `moveIf`, which `IdbFs` runs as one transaction with the hash computed inside it. Saves (the known-version check), sync writes, sync moves and sync deletes (to Recently Deleted) use them.
  - Saves and sync runs take one Web Lock per library (`margin:library`). A save takes it *before* entering its path queue, and a sync run only after its flush, so neither can deadlock the other.
  - A `BroadcastChannel` tells other tabs what changed. They drop cached hashes and reload clean editors; dirty ones save to a conflict copy.
  - Tests: `apps/app/test/tabs.test.ts` (40 seeded races between two tabs, plus the same race without the atomic write, showing the old loss) and a WebKit two-tab probe.
- **Temp files:** start-up cleanup removes only `.margin-*.tmp` files older than 60 s, so a second tab opening no longer deletes the first tab's write in progress.
- **Revoked or expired sessions:** any 401 (from `/api/me` or sync) is handled like Sign Out. The app flushes, deletes the cached shell and goes to the sign-in page. **The documents in this browser's IndexedDB are kept on purpose:** they're the user's text, possibly not yet synced. They stay readable only to whoever can open this browser profile, and they sync again after signing back in. To remove them, delete them before signing out, or clear the site's data in Safari settings. Tested with a WebKit revoke probe.
- **Server errors:** with a cached shell, the service worker shows it on a network error, a 5xx, or no answer within 4 s. Only 401/403 delete it. Tested with a failing and a hung server in WebKit.
- **Staging:** no `*.html` at all may land in `public/`, not just `index.html`.
- **Migration:** "migrated" is recorded in IndexedDB (`started` → `done`) and never re-runs once done, even if the localStorage backup couldn't be written. A deleted document therefore can't be resurrected by a second migration.
