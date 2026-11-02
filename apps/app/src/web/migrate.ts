import { decodeUtf8, encodeUtf8, normalizeDocPath } from '@margin/core';

import type { NativeLibrary } from '../local/library';
import type { NativeFs } from '../local/nativeFs';

/** The old browser store (M1–M7): the whole library as one JSON blob in localStorage. */
export const LEGACY_LIBRARY_KEY = 'margin.library.v1';
export const LEGACY_BACKUP_KEY = 'margin.library.v1.migrated';
/** In IndexedDB, next to the library (outside it): the migration's own state. */
export const MIGRATION_MARKER = '.margin/migrated-localstorage.json';

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
 *
 * "Once" is recorded in IndexedDB, not by moving the localStorage key
 * (validator M8): `started` before copying, `done` after. A `done` marker means
 * never again, even if the localStorage backup couldn't be written (quota) and
 * the old key is still there, so a document deleted since can't come back. A
 * `started` marker (the page died mid-copy, before the library was usable)
 * resumes; copying is create-only, so that's idempotent.
 */
export async function migrateLocalStorage(library: NativeLibrary, fs: NativeFs, storage: Storage): Promise<MigrationResult | null> {
  let marker: { state?: string } | null = null;
  try {
    marker = JSON.parse(decodeUtf8(await fs.readBytes(MIGRATION_MARKER)) ?? 'null') as { state?: string } | null;
  } catch {
    marker = null; // none yet
  }
  if (marker?.state === 'done') return null;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_LIBRARY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const writeMarker = async (state: 'started' | 'done', extra: object = {}) => {
    await fs.mkdir('.margin');
    await fs.writeAtomic(MIGRATION_MARKER, encodeUtf8(JSON.stringify({ state, at: new Date().toISOString(), ...extra })));
  };
  await writeMarker('started');
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
  await writeMarker('done', { migrated: result.migrated.length, skipped: result.skipped.length });
  try {
    storage.setItem(LEGACY_BACKUP_KEY, raw);
    storage.removeItem(LEGACY_LIBRARY_KEY);
  } catch {
    /* quota: the original stays in place, untouched; the marker prevents re-migrating it */
  }
  return result;
}
