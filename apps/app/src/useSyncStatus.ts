import type { SyncStatus } from '@margin/core';
import { useEffect, useState } from 'react';

import { getSyncSource } from './storage/documentStore';

/** Sync status (desktop: from main; iOS: the native sync service); null where there's no sync (browser). */
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    const sync = getSyncSource();
    if (!sync) return;
    let live = true;
    void sync.status().then((s) => live && setStatus(s));
    const off = sync.onChange((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}

/** One quiet word or phrase; null = show nothing. */
export function syncLabel(s: SyncStatus | null): string | null {
  if (!s) return null;
  switch (s.state) {
    case 'off':
      return null;
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      // Backing off after the server said "busy" (503 + Retry-After) reads as a pause, not as offline.
      return s.message?.startsWith('Sync paused') ? s.message : 'Offline';
    case 'error':
      return `Sync error${s.message ? `: ${s.message}` : ''}`;
    case 'idle':
      return s.message ? `Synced · ${s.message}` : 'Synced';
  }
}
