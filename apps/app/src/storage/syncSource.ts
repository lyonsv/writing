import type { SyncStatus } from '@margin/core';

/** Where the UI reads sync status from (desktop main process, or the iOS sync service). */
export interface SyncSource {
  status(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  onChange(listener: (status: SyncStatus) => void): () => void;
}
