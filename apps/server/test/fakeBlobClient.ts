import { createHash } from 'node:crypto';

import { BlobError, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';

import type { BlobClient } from '../src/blobStore';

/**
 * In-memory stand-in for `@vercel/blob` that reproduces the behaviours
 * `verify:blob` observed on the real private store (ADR 0012 amendments):
 * - ETags are content-derived;
 * - create-only (`allowOverwrite: false`) on an existing key → plain BlobError;
 * - ifMatch on a missing key → plain BlobError;
 * - stale ifMatch → BlobPreconditionFailedError;
 * - get() returns a *weak* ETag for larger (compressed) bodies; head() a strong one.
 * Every call yields first, so concurrent callers interleave.
 */
export function fakeBlobClient(): BlobClient & { keys: () => string[] } {
  const items = new Map<string, { bytes: Uint8Array; etag: string }>();
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  const etagOf = (b: Uint8Array) => `"${createHash('md5').update(b).digest('hex')}"`;
  const toBytes = async (body: unknown): Promise<Uint8Array> =>
    typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body as ArrayBuffer | Uint8Array);
  const client = {
    async put(key: string, body: unknown, opts: { allowOverwrite?: boolean; ifMatch?: string }) {
      await tick();
      const cur = items.get(key);
      if (opts.ifMatch !== undefined) {
        if (!cur) throw new BlobError('The specified key does not exist.');
        if (cur.etag !== opts.ifMatch) throw new BlobPreconditionFailedError();
      } else if (!opts.allowOverwrite && cur) {
        throw new BlobError('This blob already exists, use `allowOverwrite: true` if you want to overwrite it.');
      }
      const bytes = await toBytes(body);
      const etag = etagOf(bytes);
      items.set(key, { bytes, etag });
      return { etag, url: `https://blob.test/${key}`, pathname: key };
    },
    async get(key: string) {
      await tick();
      const cur = items.get(key);
      if (!cur) return null;
      return {
        statusCode: 200,
        stream: new Response(cur.bytes.slice()).body,
        headers: new Headers(),
        blob: { etag: cur.bytes.length > 1000 ? `W/${cur.etag}` : cur.etag, pathname: key },
      };
    },
    async head(key: string) {
      await tick();
      const cur = items.get(key);
      if (!cur) throw new BlobNotFoundError();
      return { etag: cur.etag, pathname: key };
    },
    async del(key: string) {
      await tick();
      items.delete(key);
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      await tick();
      return { blobs: [...items.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname })), hasMore: false };
    },
    keys: () => [...items.keys()],
  };
  return client as unknown as BlobClient & { keys: () => string[] };
}
