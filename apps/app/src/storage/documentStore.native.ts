import type { DesktopBridge, DocumentStore, SettingsStore } from '@margin/core';

import { library, ready, settingsStore, sync } from '../native/services';
import type { DocumentBackend } from './documentBackend';
import type { LibraryBackend } from './libraryBackend';
import type { SyncSource } from './syncSource';

/** No desktop bridge on iOS. */
export function getDesktopBridge(): DesktopBridge | undefined {
  return undefined;
}

/** Every call waits for the library folder to exist (first launch) and leftovers to be cleaned. */
const after =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    await ready;
    return fn(...args);
  };

/** iOS: `.md` files in the app's documents directory (ADR 0015). */
const store: DocumentStore = {
  list: after((f?: string) => library.list(f)),
  read: after((p: string) => library.read(p)),
  write: after((p: string, c: string) => library.write(p, c)),
  rename: after((a: string, b: string) => library.rename(a, b)),
  delete: after((p: string) => library.delete(p)),
  createFolder: after((p: string) => library.createFolder(p)),
};

export function getDocumentStore(): DocumentStore {
  return store;
}

/** The open document: same contract as desktop (known version, conflict copies, external changes from sync). */
const backend: DocumentBackend = {
  open: after((p: string) => library.open(p)),
  save: after((p: string, c: string) => library.save(p, c)),
  acknowledgeExternal: after((p: string, t: string) => library.acknowledgeExternal(p, t)),
  onExternalChange: (l) => library.onExternalChange(l),
};

export function getDocumentBackend(): DocumentBackend {
  return backend;
}

export function getSettingsStore(): SettingsStore {
  return settingsStore;
}

/** "trash" is Recently Deleted (there's no system Trash on iOS). */
const libraryBackend: LibraryBackend = {
  listTree: after(() => library.listTree()),
  createDocument: after((p: string) => library.createDocument(p)),
  createFolder: after((p: string) => library.createFolder(p)),
  rename: after((a: string, b: string) => library.rename(a, b)),
  trash: after((p: string) => library.delete(p)),
  onChange: (l) => library.onChange(l),
};

export function getLibraryBackend(): LibraryBackend {
  return libraryBackend;
}

const syncSource: SyncSource = {
  status: async () => sync.status(),
  syncNow: () => sync.syncNow(),
  onChange: (l) => sync.onChange(l),
};

export function getSyncSource(): SyncSource | undefined {
  return syncSource;
}
