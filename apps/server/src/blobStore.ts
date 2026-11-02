import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob';

import { PreconditionFailedError, type KeyValueStore, type PutOptions, type StoredItem } from './store';

/** The subset of `@vercel/blob` we use; injectable so tests can fake it. */
export interface BlobClient {
  get: typeof get;
  put: typeof put;
  del: typeof del;
  list: typeof list;
}

const realClient: BlobClient = { get, put, del, list };

/**
 * `KeyValueStore` on a **private** Vercel Blob store. On Vercel the SDK
 * authenticates with OIDC (`BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN`, injected
 * automatically); locally it uses `BLOB_READ_WRITE_TOKEN`.
 *
 * - Reads bypass the CDN cache (`useCache: false`); otherwise an overwrite can
 *   take up to a minute to show, which would let a revoked token keep working.
 * - `ifMatch` maps to Blob's conditional write; `create` maps to
 *   `allowOverwrite: false`.
 * - Values are small JSON documents; `cacheControlMaxAge` is the minimum (60 s)
 *   as a second line of defence, since nothing here should be cached.
 */
export class BlobStore implements KeyValueStore {
  constructor(private readonly client: BlobClient = realClient) {}

  async get(key: string): Promise<StoredItem | null> {
    const result = await this.client.get(key, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const value = await new Response(result.stream).text();
    return { value, etag: result.blob.etag };
  }

  async put(key: string, value: string, options: PutOptions = {}): Promise<{ etag: string }> {
    try {
      const result = await this.client.put(key, value, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: !options.create,
        cacheControlMaxAge: 60,
        ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      });
      return { etag: result.etag };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new PreconditionFailedError();
      throw error;
    }
  }

  async getBytes(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const result = await this.client.get(key, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return { bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
  }

  async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<{ etag: string }> {
    try {
      const result = await this.client.put(key, Buffer.from(bytes), {
        access: 'private',
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
        allowOverwrite: !options.create,
        cacheControlMaxAge: 60,
        ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      });
      return { etag: result.etag };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new PreconditionFailedError();
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) keys.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}
