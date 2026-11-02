import { flushWorkspace } from '../local/lifecycle';
import { NativeLibrary } from '../local/library';
import type { NativeFs } from '../local/nativeFs';
import { NativeSyncService } from '../local/sync';
import { WebAccount } from './account';
import { IdbFs, openMarginDb } from './idbFs';
import { migrateLocalStorage } from './migrate';

/**
 * The browser / installed web app (not Electron; ADR 0020): the library in
 * IndexedDB through the same `NativeLibrary` as iOS, and, when served by a
 * Margin server (the shell carries `<meta name="margin-hosted">`), the cookie
 * account and the core sync engine. `pnpm dev:web` gets the library only.
 */

/** Waits for the database before every call. */
class LazyFs implements NativeFs {
  constructor(private readonly fs: Promise<NativeFs>) {}
  stat = (p: string) => this.fs.then((f) => f.stat(p));
  list = (p: string) => this.fs.then((f) => f.list(p));
  readBytes = (p: string) => this.fs.then((f) => f.readBytes(p));
  writeAtomic = (p: string, b: Uint8Array) => this.fs.then((f) => f.writeAtomic(p, b));
  move = (a: string, b: string) => this.fs.then((f) => f.move(a, b));
  mkdir = (p: string) => this.fs.then((f) => f.mkdir(p));
  remove = (p: string) => this.fs.then((f) => f.remove(p));
}

export function isHosted(): boolean {
  return typeof document !== 'undefined' && document.querySelector('meta[name="margin-hosted"]') !== null;
}

/** Drops the service worker's cached app shell (after sign-out the next load must hit the server). */
export async function clearShellCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  for (const key of await caches.keys()) if (key.startsWith('margin-')) await caches.delete(key);
  navigator.serviceWorker?.controller?.postMessage({ type: 'margin:signed-out' });
}

/** One exclusive lock per library across tabs (Web Locks); a no-op where unsupported (one tab is then the only writer that matters). */
function libraryLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return (fn) => fn();
  return (fn) => locks.request('margin:library', () => fn()) as Promise<Awaited<ReturnType<typeof fn>>>;
}

export interface WebServices {
  fs: NativeFs;
  library: NativeLibrary;
  ready: Promise<void>;
  account: WebAccount | null;
  sync: NativeSyncService | null;
}

let services: WebServices | null = null;

export function webServices(): WebServices {
  if (services) return services;
  const fs = new LazyFs(openMarginDb().then((db) => new IdbFs(db)));
  // Several tabs share one IndexedDB library (validator M8): saves and sync runs take one
  // Web Lock, and every change is broadcast so other tabs refresh and reload clean editors.
  const exclusive = libraryLock();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('margin-library') : null;
  const library = new NativeLibrary({ fs, exclusive, onLocalWrite: (path) => channel?.postMessage({ path }) });
  channel?.addEventListener('message', (e: MessageEvent<{ path?: unknown }>) => {
    if (typeof e.data?.path === 'string') library.externalWrite(e.data.path);
  });
  const ready = library.init().then(async () => {
    try {
      await migrateLocalStorage(library, fs, window.localStorage);
    } catch (e) {
      console.error('Margin: migrating the old browser library failed (it is kept in localStorage)', e);
    }
    // Ask the browser not to evict the library under storage pressure (granted
    // automatically to installed home-screen apps on iOS; best effort elsewhere).
    await navigator.storage?.persist?.().catch(() => false);
  });
  const account = isHosted()
    ? new WebAccount({
        fetch: (input, init) => fetch(input, init),
        origin: location.origin,
        storage: window.localStorage,
        navigate: (url) => location.assign(url),
        // Save what was typed first (into IndexedDB; documents are kept), then drop the cached shell.
        onSignedOut: async () => {
          await flushWorkspace().catch(() => false);
          await clearShellCaches();
        },
      })
    : null;
  const sync = account
    ? new NativeSyncService({ library, fs, account, beforeSync: () => flushWorkspace(), deviceLabel: 'browser', exclusive })
    : null;
  services = { fs, library, ready, account, sync };

  // Offline app shell (public/sw.js), only when served by a Margin server: never in
  // Electron (no webServices there) or the dev server. It never caches /api.
  if (account && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e: unknown) => console.warn('Margin: no offline shell', e));
  }

  if (sync && account) {
    let syncing = false;
    sync.onChange((s) => {
      syncing = s.state === 'syncing';
    });
    library.onChange(() => {
      if (!syncing) sync.nudge();
    });
    account.onChange((s) => {
      if (s.state === 'signed-in') sync.resume();
    });
    void ready.then(() => account.status()).then(() => sync.resume());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void account.status();
        sync.resume();
      } else {
        sync.pause();
        void flushWorkspace();
      }
    });
  }
  // Leaving or hiding the page: get pending text into IndexedDB now.
  window.addEventListener('pagehide', () => void flushWorkspace());
  return services;
}
