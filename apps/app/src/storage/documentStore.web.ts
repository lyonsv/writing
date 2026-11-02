import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DocumentStore, type SettingsStore } from '@margin/core';

import type { SyncSource } from './syncSource';

import { desktopBackend, storeBackend, type DocumentBackend } from './documentBackend';
import { desktopLibraryBackend, storeLibraryBackend, type LibraryBackend } from './libraryBackend';
import { createLocalStorageStore } from './localStorageStore';
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

/** Library-level access (list/rename/delete…). */
export function getDocumentStore(): DocumentStore {
  if (!store) {
    const bridge = getDesktopBridge();
    store = bridge ? bridge.store : createLocalStorageStore();
  }
  return store;
}

/** Open-document access (save pipeline). */
export function getDocumentBackend(): DocumentBackend {
  if (!backend) {
    const bridge = getDesktopBridge();
    backend = bridge ? desktopBackend(bridge) : storeBackend(getDocumentStore());
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
    library = bridge ? desktopLibraryBackend(bridge) : storeLibraryBackend(getDocumentStore());
  }
  return library;
}

/** Sync status source: the desktop main process; none in a plain browser. */
export function getSyncSource(): SyncSource | undefined {
  return getDesktopBridge()?.sync;
}
