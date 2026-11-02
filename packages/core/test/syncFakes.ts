import { createHash } from 'node:crypto';

import {
  SyncPreconditionError,
  SyncRejectedError,
  conflictCopyPath,
  isSyncablePath,
  MAX_SYNC_BYTES,
  type ContentHash,
  type LocalFile,
  type RemoteEntry,
  type SyncLocal,
  type SyncRemote,
} from '../src';

export const enc = (s: string) => new TextEncoder().encode(s);
export const dec = (b: Uint8Array) => new TextDecoder().decode(b);
export const sha = (b: Uint8Array): ContentHash => createHash('sha256').update(b).digest('hex');
export const shaOf = (s: string) => sha(enc(s));

/** In-memory server with the same semantics as apps/server's sync API. */
export class FakeRemote implements SyncRemote {
  entries = new Map<string, RemoteEntry & { bytes: Uint8Array }>();
  seq = 0;
  /** Runs before each mutating call (to simulate other devices racing). */
  beforeMutate?: () => Promise<void>;

  live(path: string) {
    const e = this.entries.get(path);
    return e && !e.deleted ? e : undefined;
  }

  /** Full snapshots (bytes included) after every mutation, for stale reads and rollbacks in tests. */
  history: Array<{ seq: number; entries: Map<string, RemoteEntry & { bytes: Uint8Array }> }> = [];
  /** When set, manifest() serves this snapshot index (a stale read) instead of the truth. */
  serveStale?: () => number | undefined;

  private view(entries: Map<string, RemoteEntry & { bytes: Uint8Array }>, seq: number) {
    return { seq, entries: [...entries.values()].map(({ bytes: _b, ...e }) => ({ ...e })) };
  }

  async manifest(): Promise<{ seq: number; entries: RemoteEntry[] }> {
    const i = this.serveStale?.();
    const snap = i === undefined ? undefined : this.history[i];
    return snap ? this.view(snap.entries, snap.seq) : this.view(this.entries, this.seq);
  }

  private snapshot_() {
    this.history.push({ seq: this.seq, entries: new Map(this.entries) });
  }

  /** Restores an older state (e.g. from a backup), seq included: a real rollback. */
  rollbackTo(index: number): void {
    const snap = this.history[index]!;
    this.entries = new Map(snap.entries);
    this.seq = snap.seq;
  }

  async get(path: string) {
    const e = this.live(path);
    if (!e) return null;
    const { bytes, ...entry } = e;
    return { bytes: bytes.slice(), entry: { ...entry } };
  }

  private write(path: string, bytes: Uint8Array): RemoteEntry {
    const entry = { path, rev: String(++this.seq), hash: sha(bytes), size: bytes.length, updatedAt: new Date(0).toISOString(), bytes };
    this.entries.set(path, entry);
    this.snapshot_();
    const { bytes: _b, ...e } = entry;
    return e;
  }

  async put(path: string, bytes: Uint8Array, ifMatch: string | null): Promise<RemoteEntry> {
    await this.beforeMutate?.();
    if (!isSyncablePath(path)) throw new SyncRejectedError('invalid path');
    if (bytes.length > MAX_SYNC_BYTES) throw new SyncRejectedError('too large');
    const cur = this.live(path);
    if (ifMatch === null ? cur : !cur || cur.rev !== ifMatch) throw new SyncPreconditionError();
    return this.write(path, bytes);
  }

  async delete(path: string, ifMatch: string): Promise<void> {
    await this.beforeMutate?.();
    const cur = this.live(path);
    if (!cur || cur.rev !== ifMatch) throw new SyncPreconditionError();
    this.entries.set(path, { ...cur, rev: String(++this.seq), deleted: true });
    this.snapshot_();
  }

  async move(from: string, to: string, ifMatch: string): Promise<RemoteEntry> {
    await this.beforeMutate?.();
    const cur = this.live(from);
    if (!cur || cur.rev !== ifMatch || this.live(to)) throw new SyncPreconditionError();
    this.entries.set(from, { ...cur, rev: String(++this.seq), deleted: true });
    return this.write(to, cur.bytes);
  }

  /** Live documents as path → text. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, e] of this.entries) if (!e.deleted) out[p] = dec(e.bytes);
    return out;
  }
}

/** In-memory device folder. `beforeMutate` simulates the user typing while sync runs. */
export class FakeLocal implements SyncLocal {
  files = new Map<string, Uint8Array>();
  beforeMutate?: (path: string) => Promise<void>;
  /** Called after sync overwrote (`write` over an existing file) or removed a file. */
  onDestructive?: (kind: 'overwrite' | 'remove', path: string, bytes?: Uint8Array) => void;
  constructor(private readonly date = new Date(2026, 10, 2, 12, 0)) {}

  async list(): Promise<LocalFile[]> {
    return [...this.files]
      .filter(([p]) => isSyncablePath(p))
      .map(([path, b]) => ({ path, hash: sha(b), size: b.length }));
  }

  async read(path: string) {
    const b = this.files.get(path);
    return b ? { bytes: b.slice(), hash: sha(b) } : null;
  }

  private matches(path: string, expect: ContentHash | null) {
    const b = this.files.get(path);
    return expect === null ? !b : !!b && sha(b) === expect;
  }

  async write(path: string, bytes: Uint8Array, expect: ContentHash | null) {
    await this.beforeMutate?.(path);
    if (!this.matches(path, expect)) return false;
    if (this.files.has(path)) this.onDestructive?.('overwrite', path, bytes);
    this.files.set(path, bytes.slice());
    return true;
  }

  async remove(path: string, expect: ContentHash) {
    await this.beforeMutate?.(path);
    if (!this.matches(path, expect)) return false;
    this.onDestructive?.('remove', path);
    this.files.delete(path);
    return true;
  }

  async move(from: string, to: string, expect: ContentHash) {
    await this.beforeMutate?.(from);
    if (!this.matches(from, expect) || this.files.has(to)) return false;
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
    return true;
  }

  async createConflictCopy(path: string, bytes: Uint8Array) {
    await this.beforeMutate?.(path);
    for (let attempt = 1; ; attempt++) {
      const copy = conflictCopyPath(path, this.date, attempt);
      if (!this.files.has(copy)) {
        this.files.set(copy, bytes.slice());
        return copy;
      }
    }
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, b] of this.files) out[p] = dec(b);
    return out;
  }
}
