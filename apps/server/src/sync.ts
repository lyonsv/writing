import { createHash } from 'node:crypto';

import { PreconditionFailedError, type KeyValueStore } from './store.js';
import { foldPathCase } from './syncPaths.js';

/**
 * Sync storage (ADR 0013).
 *
 * - `sync/manifest.json` is the single source of truth: path → { rev, hash,
 *   size, updatedAt, deleted? }. Every mutation is one compare-and-swap of this
 *   object (Blob `ifMatch` on its ETag), retried on contention. That makes
 *   create-only, If-Match updates, deletes (tombstones) and **moves** atomic.
 * - Document bodies are immutable, content-addressed objects
 *   `sync/objects/<sha256>`, written *before* the manifest points at them, so a
 *   reader never sees a manifest entry without its body. Objects no manifest
 *   entry references are garbage (left by a lost race); collecting them is an
 *   M8 maintenance task.
 * - Revisions come from a manifest-wide counter, so a path that's deleted and
 *   re-created never reuses a rev.
 */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** Keeps GET /api/sync/manifest under Vercel's 4.5 MB response limit. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** Tombstones older than this are dropped (clients treat "absent" like "deleted"). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const MANIFEST = 'sync/manifest.json';
const objectKey = (hash: string) => `sync/objects/${hash}`;

interface StoredEntry {
  rev: number;
  hash: string;
  size: number;
  updatedAt: number;
  deleted?: true;
}

interface Manifest {
  v: 1;
  seq: number;
  entries: Record<string, StoredEntry>;
}

export interface SyncEntry {
  path: string;
  rev: string;
  hash: string;
  size: number;
  updatedAt: string;
  deleted?: true;
}

export class SyncConflictError extends Error {
  constructor(
    readonly kind: 'precondition' | 'path',
    readonly current: SyncEntry | null,
    readonly conflictingPath?: string,
  ) {
    super(kind === 'precondition' ? 'precondition failed' : 'path conflict');
  }
}

export class SyncLimitError extends Error {}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const toEntry = (path: string, e: StoredEntry): SyncEntry => ({
  path,
  rev: String(e.rev),
  hash: e.hash,
  size: e.size,
  updatedAt: new Date(e.updatedAt).toISOString(),
  ...(e.deleted ? { deleted: true as const } : {}),
});

/** `If-Match` precondition: a rev, or null for create-only (`If-None-Match: *`). */
export type Precondition = { ifMatch: string } | { ifNoneMatch: true };

export class SyncRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(): Promise<{ manifest: Manifest; etag: string | null }> {
    const item = await this.store.get(MANIFEST);
    if (!item) return { manifest: { v: 1, seq: 0, entries: {} }, etag: null };
    return { manifest: JSON.parse(item.value) as Manifest, etag: item.etag };
  }

  async manifest(): Promise<{ seq: number; entries: SyncEntry[] }> {
    const { manifest } = await this.read();
    return { seq: manifest.seq, entries: Object.entries(manifest.entries).map(([p, e]) => toEntry(p, e)) };
  }

  async get(path: string): Promise<{ entry: SyncEntry; bytes: Uint8Array } | null> {
    const { manifest } = await this.read();
    const e = manifest.entries[path];
    if (!e || e.deleted) return null;
    const obj = await this.store.getBytes(objectKey(e.hash));
    if (!obj) throw new Error('manifest points at a missing object');
    return { entry: toEntry(path, e), bytes: obj.bytes };
  }

  /** Applies `mutate` to the latest manifest with compare-and-swap, retrying on contention. */
  /**
   * Each CAS round lets at least one writer through, so N concurrent writers
   * need at most N rounds. On real Blob a round is ~300 ms, so we retry with
   * capped exponential backoff plus jitter for up to ~25 s (well within a
   * Function's duration) rather than a fixed small number of attempts.
   */
  private async update<T>(mutate: (m: Manifest) => T): Promise<T> {
    const deadline = this.now() + 25_000;
    for (let attempt = 0; attempt < 200 && (attempt === 0 || Date.now() < deadline); attempt++) {
      const { manifest, etag } = await this.read();
      const result = mutate(manifest); // throws SyncConflictError on a failed precondition
      this.prune(manifest);
      const json = JSON.stringify(manifest);
      if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) throw new SyncLimitError('library too large to sync');
      try {
        await this.store.put(MANIFEST, json, etag === null ? { create: true } : { ifMatch: etag });
        return result;
      } catch (error) {
        if (!(error instanceof PreconditionFailedError)) throw error;
        const cap = Math.min(1_000, 25 * 2 ** Math.min(attempt, 6));
        await new Promise((r) => setTimeout(r, cap / 2 + Math.random() * cap));
      }
    }
    throw new Error('sync manifest is too contended');
  }

  private prune(m: Manifest): void {
    const t = this.now();
    for (const [p, e] of Object.entries(m.entries)) if (e.deleted && t - e.updatedAt > TOMBSTONE_TTL_MS) delete m.entries[p];
  }

  private live(m: Manifest, path: string): StoredEntry | undefined {
    const e = m.entries[path];
    return e && !e.deleted ? e : undefined;
  }

  private check(m: Manifest, path: string, pre: Precondition): void {
    const cur = this.live(m, path);
    const ok = 'ifNoneMatch' in pre ? !cur : !!cur && String(cur.rev) === pre.ifMatch;
    if (!ok) throw new SyncConflictError('precondition', cur ? toEntry(path, cur) : null);
  }

  /**
   * A new live path must not collide with another live path on a
   * case-insensitive filesystem (macOS, iOS) or as file-vs-folder
   * (`a.md` vs `a.md/b.md`). `except` is the path being moved away.
   */
  private checkFree(m: Manifest, path: string, except?: string): void {
    const lower = foldPathCase(path);
    for (const [p, e] of Object.entries(m.entries)) {
      if (e.deleted || p === path || p === except) continue;
      const q = foldPathCase(p);
      if (q === lower || q.startsWith(`${lower}/`) || lower.startsWith(`${q}/`)) {
        throw new SyncConflictError('path', null, p);
      }
    }
  }

  private async storeObject(bytes: Uint8Array): Promise<string> {
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new SyncLimitError('document too large');
    const hash = sha256Hex(bytes);
    // Content-addressed: create-only, and "already exists" means the same bytes are
    // already stored. One write instead of read-then-write (each call counts on GitHub).
    try {
      await this.store.putBytes(objectKey(hash), bytes, { create: true });
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
    }
    return hash;
  }

  async put(path: string, bytes: Uint8Array, pre: Precondition): Promise<SyncEntry> {
    const hash = await this.storeObject(bytes);
    return this.update((m) => {
      this.check(m, path, pre);
      if ('ifNoneMatch' in pre) this.checkFree(m, path);
      const e: StoredEntry = { rev: ++m.seq, hash, size: bytes.length, updatedAt: this.now() };
      m.entries[path] = e;
      return toEntry(path, e);
    });
  }

  async delete(path: string, ifMatch: string): Promise<SyncEntry> {
    return this.update((m) => {
      this.check(m, path, { ifMatch });
      const cur = m.entries[path]!;
      const e: StoredEntry = { ...cur, rev: ++m.seq, updatedAt: this.now(), deleted: true };
      m.entries[path] = e;
      return toEntry(path, e);
    });
  }

  /** Atomic: `from` becomes a tombstone and `to` gets its content, in one manifest write. */
  async move(from: string, to: string, ifMatch: string): Promise<SyncEntry> {
    return this.update((m) => {
      this.check(m, from, { ifMatch });
      if (from === to) throw new SyncConflictError('path', null, to);
      this.check(m, to, { ifNoneMatch: true });
      this.checkFree(m, to, from);
      const cur = m.entries[from]!;
      const t = this.now();
      m.entries[from] = { ...cur, rev: ++m.seq, updatedAt: t, deleted: true };
      const e: StoredEntry = { rev: ++m.seq, hash: cur.hash, size: cur.size, updatedAt: t };
      m.entries[to] = e;
      return toEntry(to, e);
    });
  }
}
