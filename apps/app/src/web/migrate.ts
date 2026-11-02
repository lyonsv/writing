import { encodeUtf8, normalizeDocPath } from '@margin/core';

import type { NativeLibrary } from '../local/library';

/** The old browser store (M1–M7): the whole library as one JSON blob in localStorage. */
export const LEGACY_LIBRARY_KEY = 'margin.library.v1';
export const LEGACY_BACKUP_KEY = 'margin.library.v1.migrated';

export interface MigrationResult {
  migrated: string[];
  /** Documents left only in the backup (invalid path, or a different file already at that path). */
  skipped: string[];
}

/**
 * Moves documents from the old localStorage store into the IndexedDB library,
 * once. Never overwrites: a document whose path is already taken stays in the
 * backup. The old blob is kept under `margin.library.v1.migrated` rather than
 * deleted, so nothing can be lost by a failed or partial migration.
 */
export async function migrateLocalStorage(library: NativeLibrary, storage: Storage): Promise<MigrationResult | null> {
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_LIBRARY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const result: MigrationResult = { migrated: [], skipped: [] };
  let parsed: { docs?: Record<string, { content?: unknown }>; folders?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    parsed = {};
  }
  for (const folder of Array.isArray(parsed.folders) ? parsed.folders : []) {
    if (typeof folder !== 'string') continue;
    try {
      await library.createFolder(normalizeDocPath(folder));
    } catch {
      /* invalid or hidden: it stays in the backup */
    }
  }
  for (const [path, doc] of Object.entries(parsed.docs ?? {})) {
    const content = typeof doc?.content === 'string' ? doc.content : null;
    if (content === null) continue;
    try {
      // Create-only: an existing file at that path is never replaced.
      if (await library.writeForSync(path, encodeUtf8(content), null)) result.migrated.push(path);
      else result.skipped.push(path);
    } catch {
      result.skipped.push(path);
    }
  }
  try {
    storage.setItem(LEGACY_BACKUP_KEY, raw);
    storage.removeItem(LEGACY_LIBRARY_KEY);
  } catch {
    /* quota: leave the original in place; the next run skips what already exists */
  }
  return result;
}
