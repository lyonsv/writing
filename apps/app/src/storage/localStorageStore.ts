import { MemoryDocumentStore, type MemoryStoreSnapshot } from '@margin/core';

const STORAGE_KEY = 'margin.library.v1';

function load(storage: Storage): MemoryStoreSnapshot | undefined {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<MemoryStoreSnapshot>;
    if (typeof parsed.docs !== 'object' || !Array.isArray(parsed.folders)) return undefined;
    return { docs: parsed.docs ?? {}, folders: parsed.folders };
  } catch {
    return undefined;
  }
}

/** Browser adapter: the whole library is one JSON blob in localStorage. */
export function createLocalStorageStore(storage: Storage = window.localStorage): MemoryDocumentStore {
  return new MemoryDocumentStore(load(storage), {
    onChange: (snapshot) => {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch (error) {
        console.error('Margin: failed to persist library to localStorage', error);
      }
    },
  });
}
