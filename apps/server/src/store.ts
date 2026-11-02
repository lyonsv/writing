import { createHash } from 'node:crypto';

/**
 * Minimal key/value storage with ETags, implemented by Vercel Blob (private
 * store) in production and by `MemoryStore` in tests and local dev. M5 reuses
 * it for documents. See docs/decisions/0012-token-storage.md.
 *
 * Semantics every implementation must provide:
 * - `get` reads the latest committed value (no CDN cache).
 * - `put` with `ifMatch` writes only if the current ETag equals it, otherwise
 *   throws `PreconditionFailedError`. Callers must not rely on what `ifMatch`
 *   does for a key that doesn't exist (Blob doesn't document it).
 * - `put` with `create: true` never overwrites an existing key.
 * - ETags are derived from the content (as on real Blob): writing identical
 *   bytes again gives the same ETag. CAS users must therefore never let a key
 *   return to an earlier value (ours always change a counter or timestamp).
 */
export interface StoredItem {
  value: string;
  etag: string;
}

export interface PutOptions {
  ifMatch?: string;
  /** Fail instead of overwriting if the key exists. */
  create?: boolean;
}

export interface KeyValueStore {
  get(key: string): Promise<StoredItem | null>;
  put(key: string, value: string, options?: PutOptions): Promise<{ etag: string }>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Every key starting with `prefix`. */
  list(prefix: string): Promise<string[]>;
  /** Binary values (sync document bodies), same semantics as `get`/`put`. */
  getBytes(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  putBytes(key: string, bytes: Uint8Array, options?: PutOptions): Promise<{ etag: string }>;
}

export class PreconditionFailedError extends Error {
  constructor() {
    super('Precondition failed');
    this.name = 'PreconditionFailedError';
  }
}

/**
 * In-memory store for tests and local development. Each instance is separate,
 * so it's only correct with a single server process. Operations yield to the
 * event loop first, so concurrent callers interleave the way they would
 * against a remote store.
 */
export class MemoryStore implements KeyValueStore {
  private readonly items = new Map<string, StoredItem & { bytes?: Uint8Array }>();

  async get(key: string): Promise<StoredItem | null> {
    await Promise.resolve();
    const item = this.items.get(key);
    return item ? { ...item } : null;
  }

  async put(key: string, value: string, options: PutOptions = {}): Promise<{ etag: string }> {
    await Promise.resolve();
    const current = this.items.get(key);
    if (options.create && current) throw new PreconditionFailedError();
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) throw new PreconditionFailedError();
    // Content-derived, like real Blob (verified): same bytes → same ETag.
    const etag = `"${createHash('sha256').update(value).digest('hex').slice(0, 32)}"`;
    this.items.set(key, { value, etag });
    return { etag };
  }

  async delete(key: string): Promise<void> {
    await Promise.resolve();
    this.items.delete(key);
  }

  async getBytes(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    await Promise.resolve();
    const item = this.items.get(key);
    if (!item) return null;
    return { bytes: (item.bytes ?? new TextEncoder().encode(item.value)).slice(), etag: item.etag };
  }

  async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<{ etag: string }> {
    await this.put(key, '', options); // precondition checks
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
    this.items.set(key, { value: '', etag, bytes: bytes.slice() });
    return { etag };
  }

  async list(prefix: string): Promise<string[]> {
    await Promise.resolve();
    return [...this.items.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Test helper. */
  size(): number {
    return this.items.size;
  }
}
