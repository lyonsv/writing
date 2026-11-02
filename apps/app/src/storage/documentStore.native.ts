import {
  MemoryDocumentStore,
  MemorySettingsStore,
  type DesktopBridge,
  type DocumentStore,
  type SettingsStore,
} from '@margin/core';

import { storeBackend, type DocumentBackend } from './documentBackend';

/** No desktop bridge on iOS. */
export function getDesktopBridge(): DesktopBridge | undefined {
  return undefined;
}

let store: DocumentStore | undefined;
let backend: DocumentBackend | undefined;

/**
 * Stub until M6: an in-memory store, so text is lost when the app quits.
 * Will be replaced by an expo-file-system adapter.
 */
export function getDocumentStore(): DocumentStore {
  store ??= new MemoryDocumentStore();
  return store;
}

export function getDocumentBackend(): DocumentBackend {
  backend ??= storeBackend(getDocumentStore());
  return backend;
}

let settings: SettingsStore | undefined;

/** Stub until M6: in-memory settings (reset on launch). */
export function getSettingsStore(): SettingsStore {
  settings ??= new MemorySettingsStore();
  return settings;
}
