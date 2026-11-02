import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DocumentStore, type SettingsStore } from '@margin/core';

import type { SyncSource } from './syncSource';

import { desktopBackend, type DocumentBackend } from './documentBackend';
import { desktopLibraryBackend, type LibraryBackend } from './libraryBackend';
import { webServices } from '../web/services';
import { desktopSettingsStore, localStorageSettingsStore } from './settingsStore';

/**
 * The web bundle runs both in a browser and inside the Electron shell, so the
 * choice here is necessarily at runtime: the preload bridge is either there or not.
 */
export function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE_KEY];
}

let store: DocumentStore | undefined;
let backend: DocumentBackend | undefined;

/** Waits for the IndexedDB library (and the one-off localStorage migration) before each call. */
const after =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    await webServices().ready;
    return fn(...args);
  };

/**
 * Library-level access (list/rename/delete…). Electron: real files in main.
 * Browser / installed web app: `NativeLibrary` on IndexedDB (ADR 0020).
 */
export function getDocumentStore(): DocumentStore {
  if (!store) {
    const bridge = getDesktopBridge();
    if (bridge) store = bridge.store;
    else {
      const { library } = webServices();
      store = {
        list: after((f?: string) => library.list(f)),
        read: after((p: string) => library.read(p)),
        write: after((p: string, c: string) => library.write(p, c)),
        rename: after((a: string, b: string) => library.rename(a, b)),
        delete: after((p: string) => library.delete(p)),
        createFolder: after((p: string) => library.createFolder(p)),
      };
    }
  }
  return store;
}

/** Open-document access (save pipeline). Same contract as desktop and iOS: known versions, conflict copies, external changes from sync. */
export function getDocumentBackend(): DocumentBackend {
  if (!backend) {
    const bridge = getDesktopBridge();
    if (bridge) backend = desktopBackend(bridge);
    else {
      const { library } = webServices();
      backend = {
        open: after((p: string) => library.open(p)),
        save: after((p: string, c: string) => library.save(p, c)),
        acknowledgeExternal: after((p: string, t: string) => library.acknowledgeExternal(p, t)),
        onExternalChange: (l) => library.onExternalChange(l),
      };
    }
  }
  return backend;
}

let settings: SettingsStore | undefined;

/** Settings persistence: Electron userData JSON via IPC, or localStorage in a browser. */
export function getSettingsStore(): SettingsStore {
  if (!settings) {
    const bridge = getDesktopBridge();
    settings = bridge ? desktopSettingsStore(bridge) : localStorageSettingsStore();
  }
  return settings;
}

let library: LibraryBackend | undefined;

export function getLibraryBackend(): LibraryBackend {
  if (!library) {
    const bridge = getDesktopBridge();
    if (bridge) library = desktopLibraryBackend(bridge);
    else {
      const lib = webServices().library;
      library = {
        listTree: after(() => lib.listTree()),
        createDocument: after((p: string) => lib.createDocument(p)),
        createFolder: after((p: string) => lib.createFolder(p)),
        rename: after((a: string, b: string) => lib.rename(a, b)),
        trash: after((p: string) => lib.delete(p)), // Recently Deleted
        onChange: (l) => lib.onChange(l),
      };
    }
  }
  return library;
}

/** Sync status source: the desktop main process, or the web app's sync service when hosted by a Margin server. */
export function getSyncSource(): SyncSource | undefined {
  const bridge = getDesktopBridge();
  if (bridge) return bridge.sync;
  const sync = webServices().sync;
  return sync ? { status: async () => sync.status(), syncNow: () => sync.syncNow(), onChange: (l) => sync.onChange(l) } : undefined;
}
