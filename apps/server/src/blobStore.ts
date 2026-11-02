import { BlobNotFoundError, BlobPreconditionFailedError, del, get, head, list, put } from '@vercel/blob';

import { PreconditionFailedError, type KeyValueStore, type PutOptions, type StoredItem } from './store';

/** The subset of `@vercel/blob` we use; injectable so tests can fake it. */
export interface BlobClient {
  get: typeof get;
  put: typeof put;
  del: typeof del;
  list: typeof list;
  head: typeof head;
}

const realClient: BlobClient = { get, put, del, list, head };

/**
 * Real Blob's `get()` returns a *weak* ETag (`W/"…"`) once a response is served
 * compressed (larger JSON), but conditional `put`/`del` only match the strong
 * form, so a weak ETag can never win a compare-and-swap. Found with
 * `verify:blob`: the sync manifest's CAS starved as soon as it grew. Same
 * validator either way, so we drop the `W/`.
 */
export function strongEtag(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

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
    return { value, etag: strongEtag(result.blob.etag) };
  }

  /**
   * Real Blob reports several conditional-write failures as plain `BlobError`s
   * (verified with `pnpm --filter @margin/server verify:blob`; ADR 0012
   * amendments): create-only on an existing key ("This blob already exists"),
   * ifMatch on a missing key ("The specified key does not exist"), and a losing
   * concurrent conditional write ("The conditional request cannot succeed due
   * to a conflicting operation"). Callers retry on PreconditionFailedError, so
   * we classify by *state*, not by message: after a failed conditional write we
   * read the key's ETag. If it contradicts the condition (present for create;
   * missing or different for ifMatch), it's a PreconditionFailedError. If the
   * key still satisfies the condition after a short re-check, the error was
   * something else and is rethrown.
   */
  private async conditionalFailure(key: string, options: PutOptions, error: unknown): Promise<never> {
    if (error instanceof BlobPreconditionFailedError) throw new PreconditionFailedError();
    if (!options.create && options.ifMatch === undefined) throw error;
    for (let check = 0; check < 3; check++) {
      if (check > 0) await new Promise((r) => setTimeout(r, 100 * check));
      const etag = await this.currentEtag(key);
      const contradicts = options.create ? etag !== null : etag === null || etag !== options.ifMatch;
      if (contradicts) throw new PreconditionFailedError();
    }
    throw error;
  }

  /** The key's current ETag, or null if it doesn't exist. */
  private async currentEtag(key: string): Promise<string | null> {
    try {
      return strongEtag((await this.client.head(key)).etag);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
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
      return this.conditionalFailure(key, options, error);
    }
  }

  async getBytes(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const result = await this.client.get(key, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return { bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()), etag: strongEtag(result.blob.etag) };
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
      return this.conditionalFailure(key, options, error);
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
