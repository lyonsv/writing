import { BlobStore } from './blobStore.js';
import { MemoryStore, type KeyValueStore } from './store.js';

/**
 * Picks the storage backend:
 * - `MARGIN_STORE=memory` → in-memory (local dev and tests only; refused on Vercel,
 *   where each instance would get its own empty store).
 * - otherwise Vercel Blob (private store). On Vercel, `BLOB_STORE_ID` and the
 *   OIDC token are injected when the store is connected to the project; locally,
 *   `BLOB_READ_WRITE_TOKEN` works too.
 */
export function storeFromEnv(env: Record<string, string | undefined> = process.env): KeyValueStore {
  if (env.MARGIN_STORE === 'memory') {
    if (env.VERCEL) throw new Error('MARGIN_STORE=memory is not allowed on Vercel');
    return new MemoryStore();
  }
  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('No Blob store configured: connect a private Blob store, or set MARGIN_STORE=memory locally');
  }
  return new BlobStore();
}
