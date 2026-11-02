import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DocumentStore } from '@margin/core';

import { desktopBackend, storeBackend, type DocumentBackend } from './documentBackend';
import { createLocalStorageStore } from './localStorageStore';

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
