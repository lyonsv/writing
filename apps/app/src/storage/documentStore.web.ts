import { DESKTOP_BRIDGE_KEY, type DesktopBridge, type DocumentStore } from '@margin/core';

import { createDesktopStore } from './desktopStore';
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

export function getDocumentStore(): DocumentStore {
  if (!store) {
    const bridge = getDesktopBridge();
    store = bridge ? createDesktopStore(bridge) : createLocalStorageStore();
  }
  return store;
}
