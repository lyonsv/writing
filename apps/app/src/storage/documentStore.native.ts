import { MemoryDocumentStore, type DesktopBridge, type DocumentStore } from '@margin/core';

/** No desktop bridge on iOS. */
export function getDesktopBridge(): DesktopBridge | undefined {
  return undefined;
}

let store: DocumentStore | undefined;

/**
 * Stub until M5: an in-memory store, so text is lost when the app quits.
 * Will be replaced by an expo-file-system adapter.
 */
export function getDocumentStore(): DocumentStore {
  store ??= new MemoryDocumentStore();
  return store;
}
