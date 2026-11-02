import {
  DocumentStoreError,
  LIBRARY_LIST_LIMIT,
  MAX_FILENAME_BYTES,
  MAX_SYNC_PATH_BYTES,
  SerialQueue,
  basename,
  conflictCopyPath,
  decodeLatin1,
  decodeUtf8,
  dirname,
  documentEntry,
  encodeUtf8,
  folderEntry,
  foldPathCase,
  isHiddenPath,
  isMarkdownPath,
  isWithin,
  joinDocPath,
  normalizeDocPath,
  rebasePath,
  sortEntries,
  toHex,
  uniqueName,
  type DocumentStore,
  type ExternalChange,
  type LibraryEntry,
  type LibraryListing,
  type OpenedDocument,
  type SaveResult,
} from '@margin/core';
import { sha256 } from '@noble/hashes/sha256';

import { FsExistsError, type FsStat, type NativeFs } from './nativeFs';

/** Lowercase hex SHA-256 (same as desktop and server; ADR 0013). Synchronous, pure JS. */
export const sha256Hex = (bytes: Uint8Array): string => toHex(sha256(bytes));

/** Temp files younger than this may belong to a write in progress (another tab); cleanup leaves them. */
export const TEMP_MAX_AGE_MS = 60_000;

/** How long deleted items stay in Recently Deleted. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrashItem {
  id: string;
  /** Library path it was deleted from. */
  originalPath: string;
  kind: 'document' | 'folder';
  deletedAt: number;
}

export interface NativeLibraryOptions {
  fs: NativeFs;
  /** Library folder, relative to the fs base. Default `Margin`. */
  root?: string;
  /** Recently Deleted, outside the library (so listings and sync never see it). Default `.margin/trash`. */
  trashDir?: string;
  now?: () => Date;
  /** Random id for temp and trash names. */
  randomId?: () => string;
  /**
   * Web (several tabs on one IndexedDB): runs each save under a lock shared by
   * every tab of this library (Web Locks), the same one sync runs take.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Called after this instance changed `path` ('' = structure), to tell other tabs (BroadcastChannel). */
  onLocalWrite?: (path: string) => void;
}

interface Known {
  hash: string;
  /** Size and mtime when `hash` was last verified, to skip re-hashing; null forces a hash check. */
  stat: { size: number; modifiedAt: number } | null;
}

const defaultId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * The iOS library: real `.md` files under the app's documents directory, with
 * the same guarantees as the desktop `FileSystemLibrary` (ADR 0006/0008) where
 * the platform allows. See docs/decisions/0015-ios-storage.md.
 *
 * - Paths: `normalizeDocPath` (no absolute, `..`, backslash, NUL), `.md` files
 *   only, no hidden segments, every name ≤ 255 UTF-8 bytes, path ≤ 1024 bytes.
 *   Containment is by construction: the fs only takes paths under `root`, and
 *   the app container has no symlinks we create.
 * - Writes: per-path serial queue, coalesced (latest requested text wins),
 *   atomic replace (temp + rename, `NativeFs.writeAtomic`).
 * - Create/rename/move never replace anything (`NativeFs.move` refuses an
 *   existing target); case-only renames go via a hidden temp name.
 * - Opened documents remember the version we last read/wrote. A save over a
 *   file that changed underneath (sync download) goes to a conflict copy.
 * - Delete moves the item to Recently Deleted (`.margin/trash`), kept 30 days.
 * - Sync (ADR 0013) goes through `*ForSync`: same queue, hash-guarded, and it
 *   doesn't update the known version, so an open editor hears about the change
 *   like a desktop watcher event (clean: reload; dirty: conflict copy).
 */
export class NativeLibrary implements DocumentStore {
  readonly root: string;
  readonly trashDir: string;
  private readonly fs: NativeFs;
  private readonly queue = new SerialQueue();
  private readonly latestWrite = new Map<string, number>();
  private writeSeq = 0;
  private readonly known = new Map<string, Known>();
  private readonly redirects = new Map<string, { to: string; diskHash: string }>();
  private readonly moved = new Map<string, string>();
  private readonly readOnly = new Set<string>();
  /** Sync hash cache: our process is the only writer, so it's invalidated on every mutation. */
  private readonly hashCache = new Map<string, { size: number; modifiedAt: number; hash: string }>();
  private readonly externalListeners = new Set<(c: ExternalChange) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly options: NativeLibraryOptions) {
    this.fs = options.fs;
    this.root = options.root ?? 'Margin';
    this.trashDir = options.trashDir ?? '.margin/trash';
  }

  async init(): Promise<void> {
    await this.fs.mkdir(this.root);
    await this.fs.mkdir(this.trashDir);
    await this.cleanTemps('');
    await this.purgeTrash().catch(() => undefined);
  }

  /** Waits for every queued operation. */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** The editor's open document changed on disk (sync). */
  onExternalChange(listener: (c: ExternalChange) => void): () => void {
    this.externalListeners.add(listener);
    return () => void this.externalListeners.delete(listener);
  }

  /** Anything in the library changed (for the list UI and sync nudges). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => void this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.changeListeners) l();
  }

  /** A change made here: listeners, plus other tabs (`onLocalWrite`). */
  private changedLocally(path = ''): void {
    this.changed();
    this.options.onLocalWrite?.(path);
  }

  /**
   * Another writer (another browser tab) changed `path` ('' = anything): forget
   * cached hashes and stat shortcuts, refresh listings, and offer an open
   * document's new text to its editor (clean editors reload; dirty ones save to
   * a conflict copy, ADR 0006).
   */
  externalWrite(path: string): void {
    if (path === '') {
      this.hashCache.clear();
      for (const k of this.known.values()) k.stat = null;
    } else {
      this.hashCache.delete(path);
      this.invalidateKnownStat(path);
      this.checkExternal(path);
    }
    this.changed();
  }

  // ---------------------------------------------------------------- paths

  private abs(key: string): string {
    return key === '' ? this.root : `${this.root}/${key}`;
  }

  private key(relative: string, options: { allowRoot?: boolean } = {}): string {
    let key: string;
    try {
      key = normalizeDocPath(relative, options);
    } catch (error) {
      throw new DocumentStoreError('invalid-path', (error as Error).message);
    }
    if (encodeUtf8(key).length > MAX_SYNC_PATH_BYTES) throw new DocumentStoreError('invalid-path', 'Path is too long');
    if (key.split('/').some((s) => encodeUtf8(s).length > MAX_FILENAME_BYTES)) {
      throw new DocumentStoreError('invalid-path', 'Name is too long');
    }
    return key;
  }

  private assertDocumentPath(key: string): void {
    if (isHiddenPath(key)) throw new DocumentStoreError('invalid-path', `Hidden names aren't allowed: ${key}`);
    if (!isMarkdownPath(key)) throw new DocumentStoreError('invalid-path', `Only .md documents: ${key}`);
  }

  private assertFolderPath(key: string): void {
    if (isHiddenPath(key)) throw new DocumentStoreError('invalid-path', `Hidden names aren't allowed: ${key}`);
  }

  private tempName(dirKey: string): string {
    return joinDocPath(this.abs(dirKey), `.margin-${(this.options.randomId ?? defaultId)()}.tmp`);
  }

  /**
   * Removes `.margin-*.tmp` leftovers of an interrupted write (never a user file),
   * but only ones older than TEMP_MAX_AGE_MS: another writer (a second browser
   * tab starting up) must not delete a temp file that is mid-write right now.
   */
  private async cleanTemps(rel: string, depth = 0): Promise<void> {
    if (depth > 64) return;
    for (const e of await this.fs.list(this.abs(rel))) {
      const p = joinDocPath(this.abs(rel), e.name);
      if (e.kind === 'file' && /^\.margin-[a-z0-9]+\.tmp$/.test(e.name)) {
        const st = await this.fs.stat(p);
        if (st && Date.now() - st.modifiedAt > TEMP_MAX_AGE_MS) await this.fs.remove(p);
      } else if (e.kind === 'dir' && !e.name.startsWith('.')) await this.cleanTemps(joinDocPath(rel, e.name), depth + 1);
    }
  }

  // ---------------------------------------------------------------- reading

  async list(folder = ''): Promise<LibraryEntry[]> {
    const parent = this.key(folder, { allowRoot: true });
    const st = await this.fs.stat(this.abs(parent));
    if (!st || st.kind !== 'dir') throw new DocumentStoreError('not-found', `No folder ${parent}`);
    const entries: LibraryEntry[] = [];
    for (const e of await this.fs.list(this.abs(parent))) {
      if (e.name.startsWith('.')) continue;
      const rel = joinDocPath(parent, e.name);
      if (e.kind === 'dir') entries.push(folderEntry(rel));
      else if (isMarkdownPath(e.name)) {
        const s = await this.fs.stat(this.abs(rel));
        if (s) entries.push({ ...documentEntry(rel, '', s.modifiedAt), size: s.size });
      }
    }
    return sortEntries(entries);
  }

  /** Recursive listing of folders and `.md` documents (dot-entries skipped). */
  async listTree(limit = LIBRARY_LIST_LIMIT): Promise<LibraryListing> {
    const out: LibraryEntry[] = [];
    let truncated = false;
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 64) {
        truncated = true;
        return;
      }
      for (const e of await this.fs.list(this.abs(rel))) {
        if (e.name.startsWith('.')) continue;
        if (e.kind === 'file' && !isMarkdownPath(e.name)) continue;
        if (out.length >= limit) {
          truncated = true;
          return;
        }
        const child = joinDocPath(rel, e.name);
        if (e.kind === 'dir') {
          out.push(folderEntry(child));
          await walk(child, depth + 1);
        } else {
          const s = await this.fs.stat(this.abs(child));
          if (s) out.push({ ...documentEntry(child, '', s.modifiedAt), size: s.size });
        }
      }
    };
    await walk('', 0);
    return { entries: out, truncated };
  }

  async read(relative: string): Promise<string | null> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    const bytes = await this.bytesOrNull(key);
    return bytes === null ? null : (decodeUtf8(bytes) ?? decodeLatin1(bytes));
  }

  private async bytesOrNull(key: string): Promise<Uint8Array | null> {
    const st = await this.fs.stat(this.abs(key));
    if (!st || st.kind !== 'file') return null;
    try {
      return await this.fs.readBytes(this.abs(key));
    } catch {
      return null;
    }
  }

  private async diskHash(key: string): Promise<{ hash: string; stat: FsStat } | null> {
    const st = await this.fs.stat(this.abs(key));
    if (!st || st.kind !== 'file') return null;
    const bytes = await this.fs.readBytes(this.abs(key));
    return { hash: sha256Hex(bytes), stat: st };
  }

  // ---------------------------------------------------------------- open documents

  /** Reads a document (creating it empty if missing) and starts tracking its version. */
  async open(relative: string): Promise<OpenedDocument> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    return this.queue.run(key, async () => {
      let bytes = await this.bytesOrNull(key);
      if (bytes === null) {
        await this.createExclusive(key, new Uint8Array()).catch((e: unknown) => {
          if (!(e instanceof DocumentStoreError && e.code === 'exists')) throw e;
        });
        bytes = (await this.bytesOrNull(key)) ?? new Uint8Array();
        this.changedLocally();
      }
      const st = await this.fs.stat(this.abs(key));
      this.known.set(key, { hash: sha256Hex(bytes), stat: st ? { size: st.size, modifiedAt: st.modifiedAt } : null });
      this.redirects.delete(key);
      this.moved.delete(key);
      const text = decodeUtf8(bytes);
      if (text === null) {
        this.readOnly.add(key);
        return { path: key, content: decodeLatin1(bytes), readOnly: 'not-utf8' as const };
      }
      this.readOnly.delete(key);
      return { path: key, content: text };
    });
  }

  /** The editor reloaded external content `token` (a hash); adopt it if disk still matches. */
  acknowledgeExternal(relative: string, token: string): Promise<boolean> {
    const key = this.key(relative);
    return this.queue.run(key, async () => {
      const disk = await this.diskHash(key);
      if (!disk || disk.hash !== token) return false;
      this.known.set(key, { hash: disk.hash, stat: { size: disk.stat.size, modifiedAt: disk.stat.modifiedAt } });
      this.redirects.delete(key);
      return true;
    });
  }

  async write(relative: string, content: string): Promise<void> {
    await this.save(relative, content);
  }

  /** Queues a save. The key is computed synchronously, so saves are ordered as they're called. */
  save(relative: string, content: string): Promise<SaveResult> {
    let key: string;
    try {
      key = this.key(relative);
      this.assertDocumentPath(key);
    } catch (error) {
      return Promise.reject(error);
    }
    for (let hops = 0; this.moved.has(key) && hops < 32; hops++) key = this.moved.get(key)!;
    if (this.readOnly.has(key)) return Promise.reject(new DocumentStoreError('invalid-path', `${key} isn't UTF-8 text; opened read-only`));
    const seq = ++this.writeSeq;
    this.latestWrite.set(key, seq);
    // The cross-tab lock is taken BEFORE entering the path queue: a save waiting for the
    // lock (held by a sync run) must not hold the queue slot that the run itself needs.
    const exclusive = this.options.exclusive ?? (<T,>(fn: () => Promise<T>) => fn());
    return exclusive(() =>
      this.queue.run(key, async (): Promise<SaveResult> => {
        if (this.latestWrite.get(key) !== seq) return { status: 'superseded', path: key };
        const result = await this.writeNow(key, encodeUtf8(content));
        this.options.onLocalWrite?.(result.status === 'conflict' ? '' : key);
        return result;
      }),
    );
  }

  /** Runs inside the queue for `key`. */
  private async writeNow(key: string, bytes: Uint8Array): Promise<SaveResult> {
    const known = this.known.get(key);
    if (known && this.fs.writeIf) {
      // Several writers (browser tabs): the "unchanged since we read it?" check and the
      // write are one transaction, so another tab's sync can't land in between.
      await this.fs.mkdir(this.abs(dirname(key)));
      const ok = await this.fs.writeIf(this.abs(key), bytes, (cur) => cur === null || cur === known.hash, sha256Hex);
      if (!ok) {
        const disk = await this.diskHash(key);
        if (disk) return this.writeConflictCopy(key, bytes, disk.hash);
        return this.writeNow(key, bytes); // vanished in between: recreate
      }
      this.hashCache.delete(key);
      const st = await this.fs.stat(this.abs(key));
      this.known.set(key, { hash: sha256Hex(bytes), stat: st ? { size: st.size, modifiedAt: st.modifiedAt } : null });
      return { status: 'saved', path: key };
    }
    if (known) {
      const st = await this.fs.stat(this.abs(key));
      const unchanged = st && known.stat && st.size === known.stat.size && st.modifiedAt === known.stat.modifiedAt;
      if (st && !unchanged) {
        const disk = await this.diskHash(key);
        if (disk && disk.hash !== known.hash) return this.writeConflictCopy(key, bytes, disk.hash);
      }
      // Missing: deleted elsewhere (sync); recreating it loses nothing.
    }
    await this.fs.mkdir(this.abs(dirname(key)));
    await this.fs.writeAtomic(this.abs(key), bytes);
    this.hashCache.delete(key);
    if (known) {
      const st = await this.fs.stat(this.abs(key));
      this.known.set(key, { hash: sha256Hex(bytes), stat: st ? { size: st.size, modifiedAt: st.modifiedAt } : null });
    }
    return { status: 'saved', path: key };
  }

  private async writeConflictCopy(key: string, bytes: Uint8Array, diskHash: string): Promise<SaveResult> {
    const redirect = this.redirects.get(key);
    if (redirect && redirect.diskHash === diskHash) {
      const result = await this.queue.run(redirect.to, () => this.writeNow(redirect.to, bytes));
      if (result.status === 'conflict') return result;
      return { status: 'conflict', path: key, conflictPath: redirect.to };
    }
    const copyKey = await this.claimConflictCopy(key, bytes);
    const st = await this.fs.stat(this.abs(copyKey));
    this.known.set(copyKey, { hash: sha256Hex(bytes), stat: st ? { size: st.size, modifiedAt: st.modifiedAt } : null });
    this.redirects.set(key, { to: copyKey, diskHash });
    this.changedLocally();
    return { status: 'conflict', path: key, conflictPath: copyKey };
  }

  private async claimConflictCopy(key: string, bytes: Uint8Array): Promise<string> {
    const now = this.options.now?.() ?? new Date();
    for (let attempt = 1; attempt < 1000; attempt++) {
      const copyKey = conflictCopyPath(key, now, attempt);
      try {
        await this.createExclusive(copyKey, bytes);
        return copyKey;
      } catch (error) {
        if (error instanceof DocumentStoreError && error.code === 'exists') continue;
        throw error;
      }
    }
    throw new Error(`Could not find a free conflict-copy name for ${key}`);
  }

  /** Creates `key` with `bytes` (temp file, then a no-replace move); `exists` if anything is there. */
  private async createExclusive(key: string, bytes: Uint8Array): Promise<void> {
    await this.fs.mkdir(this.abs(dirname(key)));
    const tmp = this.tempName(dirname(key));
    await this.fs.writeAtomic(tmp, bytes);
    try {
      await this.fs.move(tmp, this.abs(key));
    } catch (error) {
      await this.fs.remove(tmp).catch(() => undefined);
      if (error instanceof FsExistsError) throw new DocumentStoreError('exists', `${key} already exists`);
      throw error;
    }
    this.hashCache.delete(key);
  }

  // ---------------------------------------------------------------- library operations

  /** Creates an empty document; fails with `exists` rather than touching an existing file. */
  async createDocument(relative: string): Promise<void> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    await this.queue.run(key, () => this.createExclusive(key, new Uint8Array()));
    this.moved.delete(key);
    this.changedLocally();
  }

  async createFolder(relative: string): Promise<void> {
    const key = this.key(relative);
    this.assertFolderPath(key);
    const st = await this.fs.stat(this.abs(key));
    if (st?.kind === 'file') throw new DocumentStoreError('exists', `${key} is a document`);
    await this.fs.mkdir(this.abs(key));
    this.changedLocally();
  }

  /**
   * Rename or move a document or folder. Never replaces an existing destination.
   * With `expectHash` (sync), the source must still have that content.
   */
  async rename(from: string, to: string, options: { expectHash?: string } = {}): Promise<void> {
    const srcKey = this.key(from);
    const dstKey = this.key(to);
    if (srcKey === dstKey) return;
    const st = await this.fs.stat(this.abs(srcKey));
    if (!st) throw new DocumentStoreError('not-found', `No such path ${from}`);
    if (isWithin(srcKey, dstKey)) throw new DocumentStoreError('invalid-path', 'Cannot move a folder into itself');
    if (st.kind === 'dir') this.assertFolderPath(dstKey);
    else this.assertDocumentPath(dstKey);
    if (st.kind === 'dir') await this.queue.idleWhere((k) => isWithin(srcKey, k) && k !== srcKey);

    const [first, second] = [srcKey, dstKey].sort() as [string, string];
    await this.queue.run(first, () =>
      this.queue.run(second, async () => {
        // Re-check under the locks: the source may have gone (deleted, or moved by sync) meanwhile.
        const now = await this.fs.stat(this.abs(srcKey));
        if (!now || now.kind !== st.kind) throw new DocumentStoreError('not-found', `No such path ${from}`);
        const atomicCheck = options.expectHash !== undefined && st.kind === 'file' && this.fs.moveIf !== undefined;
        if (options.expectHash !== undefined && !atomicCheck) {
          const disk = st.kind === 'file' ? await this.diskHash(srcKey) : null;
          if (disk?.hash !== options.expectHash) throw new DocumentStoreError('changed', `${from} changed`);
        }
        await this.fs.mkdir(this.abs(dirname(dstKey)));
        const caseOnly = foldPathCase(srcKey) === foldPathCase(dstKey) && !(await this.existsExactly(dstKey));
        try {
          if (caseOnly) {
            // On a case-insensitive volume `dst` *is* `src`: go through a hidden temp name.
            const tmp = this.tempName(dirname(srcKey));
            await this.fs.move(this.abs(srcKey), tmp);
            try {
              await this.fs.move(tmp, this.abs(dstKey));
            } catch (error) {
              await this.fs.move(tmp, this.abs(srcKey)).catch(() => undefined);
              throw error;
            }
          } else if (atomicCheck) {
            const expect = options.expectHash;
            if (!(await this.fs.moveIf!(this.abs(srcKey), this.abs(dstKey), (cur) => cur === expect, sha256Hex))) {
              throw new DocumentStoreError('changed', `${from} changed`);
            }
          } else {
            await this.fs.move(this.abs(srcKey), this.abs(dstKey));
          }
        } catch (error) {
          if (error instanceof FsExistsError) throw new DocumentStoreError('exists', `${to} already exists`);
          throw error;
        }
        this.rebaseTracked(srcKey, dstKey);
      }),
    );
    this.changed();
    this.options.onLocalWrite?.('');
  }

  /** True if a directory entry spelled exactly like `key`'s last segment exists. */
  private async existsExactly(key: string): Promise<boolean> {
    const name = basename(key);
    return (await this.fs.list(this.abs(dirname(key)))).some((e) => e.name.normalize('NFC') === name.normalize('NFC'));
  }

  private rebaseTracked(from: string, to: string): void {
    const move = <V,>(map: Map<string, V>) => {
      for (const [k, v] of [...map]) {
        const next = rebasePath(k, from, to);
        if (next !== null) {
          map.delete(k);
          map.set(next, v);
        }
      }
    };
    for (const k of this.known.keys()) {
      const next = rebasePath(k, from, to);
      if (next !== null) this.moved.set(k, next);
    }
    move(this.known);
    move(this.redirects);
    for (const k of [...this.readOnly]) {
      const next = rebasePath(k, from, to);
      if (next !== null) {
        this.readOnly.delete(k);
        this.readOnly.add(next);
      }
    }
    for (const k of [...this.hashCache.keys()]) if (isWithin(from, k) || isWithin(to, k)) this.hashCache.delete(k);
  }

  private forgetTracked(key: string): void {
    for (const map of [this.known, this.redirects, this.moved, this.hashCache] as Map<string, unknown>[]) {
      for (const k of [...map.keys()]) if (isWithin(key, k)) map.delete(k);
    }
    for (const k of [...this.readOnly]) if (isWithin(key, k)) this.readOnly.delete(k);
  }

  /** "Delete": moves the document or folder to Recently Deleted (there is no Trash on iOS). */
  async delete(relative: string): Promise<void> {
    const key = this.key(relative);
    this.assertFolderPath(key);
    const st = await this.fs.stat(this.abs(key));
    if (st?.kind === 'dir') await this.queue.idleWhere((k) => isWithin(key, k) && k !== key);
    await this.queue.run(key, async () => {
      const now = await this.fs.stat(this.abs(key));
      if (!now) throw new DocumentStoreError('not-found', `No such path ${relative}`);
      await this.moveToTrash(key, now.kind);
      this.forgetTracked(key);
    });
    this.changedLocally();
  }

  /** With `expect`, only a file whose hash is still `expect` moves (atomically, where the store can). */
  private async moveToTrash(key: string, kind: 'file' | 'dir', expect?: string): Promise<boolean> {
    if (expect !== undefined && !this.fs.moveIf) {
      const disk = await this.diskHash(key);
      if (disk?.hash !== expect) return false;
    }
    const deletedAt = (this.options.now?.() ?? new Date()).getTime();
    const id = `${deletedAt}-${(this.options.randomId ?? defaultId)()}`;
    const dir = `${this.trashDir}/${id}`;
    await this.fs.mkdir(dir);
    const meta: TrashItem = { id, originalPath: key, kind: kind === 'dir' ? 'folder' : 'document', deletedAt };
    await this.fs.writeAtomic(`${dir}/meta.json`, encodeUtf8(JSON.stringify(meta)));
    if (expect !== undefined && this.fs.moveIf) {
      const moved = await this.fs.moveIf(this.abs(key), `${dir}/item`, (cur) => cur === expect, sha256Hex).catch(() => false);
      if (!moved) await this.fs.remove(dir);
      return moved;
    }
    await this.fs.move(this.abs(key), `${dir}/item`);
    return true;
  }

  // ---------------------------------------------------------------- Recently Deleted

  async listTrash(): Promise<TrashItem[]> {
    const out: TrashItem[] = [];
    for (const e of await this.fs.list(this.trashDir)) {
      if (e.kind !== 'dir') continue;
      try {
        const meta = JSON.parse(decodeUtf8(await this.fs.readBytes(`${this.trashDir}/${e.name}/meta.json`)) ?? '') as TrashItem;
        if (meta.id === e.name && typeof meta.originalPath === 'string' && (await this.fs.stat(`${this.trashDir}/${e.name}/item`))) out.push(meta);
      } catch {
        /* incomplete entry (crash mid-delete): left for purge */
      }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Puts an item back at its old path, or a free name next to it. Returns where it went. */
  async restore(id: string): Promise<string> {
    const item = (await this.listTrash()).find((t) => t.id === id);
    if (!item) throw new DocumentStoreError('not-found', 'That item is no longer in Recently Deleted');
    const parent = dirname(item.originalPath);
    await this.fs.mkdir(this.abs(parent));
    const taken = (await this.fs.list(this.abs(parent))).map((e) => e.name);
    const name = basename(item.originalPath);
    const free = item.kind === 'document' ? uniqueName(name.slice(0, -3), taken, name.slice(-3)) : uniqueName(name, taken);
    const target = joinDocPath(parent, free);
    await this.queue.run(target, () => this.fs.move(`${this.trashDir}/${id}/item`, this.abs(target)));
    await this.fs.remove(`${this.trashDir}/${id}`);
    this.changedLocally();
    return target;
  }

  /** Permanently removes trash entries older than the retention period (or all, with `all`). */
  async purgeTrash(all = false): Promise<void> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    for (const e of await this.fs.list(this.trashDir)) {
      const at = Number(e.name.split('-')[0]);
      if (all || !Number.isFinite(at) || now - at > TRASH_RETENTION_MS) await this.fs.remove(`${this.trashDir}/${e.name}`);
    }
  }

  // ---------------------------------------------------------------- sync (ADR 0013)

  /** Current hash of a document, cached by size + mtime (we are the only writer; every mutation drops the entry). */
  async hashForSync(relative: string): Promise<{ hash: string; size: number } | null> {
    const key = this.key(relative);
    // In the path's queue, so a save, delete or rename can't land between the stat and the read.
    return this.queue.run(key, async () => {
      const st = await this.fs.stat(this.abs(key));
      if (!st || st.kind !== 'file') return null;
      const cached = this.hashCache.get(key);
      if (cached && cached.size === st.size && cached.modifiedAt === st.modifiedAt) return { hash: cached.hash, size: st.size };
      const bytes = await this.bytesOrNull(key);
      if (!bytes) return null;
      const hash = sha256Hex(bytes);
      this.hashCache.set(key, { size: st.size, modifiedAt: st.modifiedAt, hash });
      return { hash, size: bytes.length };
    });
  }

  forgetHash(relative: string): void {
    this.hashCache.delete(relative);
  }

  async readForSync(relative: string): Promise<{ bytes: Uint8Array; hash: string } | null> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    return this.queue.run(key, async () => {
      const bytes = await this.bytesOrNull(key);
      return bytes ? { bytes, hash: sha256Hex(bytes) } : null;
    });
  }

  /** Writes only if the current hash is `expect` (null: only if absent). Doesn't touch `known`. */
  async writeForSync(relative: string, bytes: Uint8Array, expect: string | null): Promise<boolean> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    const ok = await this.queue.run(key, async () => {
      this.hashCache.delete(key);
      if (expect === null) {
        try {
          await this.createExclusive(key, bytes);
          return true;
        } catch (error) {
          if (error instanceof DocumentStoreError && error.code === 'exists') return false;
          throw error;
        }
      }
      if (this.fs.writeIf) {
        if (!(await this.fs.writeIf(this.abs(key), bytes, (cur) => cur === expect, sha256Hex))) return false;
      } else {
        const disk = await this.diskHash(key);
        if (disk?.hash !== expect) return false;
        await this.fs.writeAtomic(this.abs(key), bytes);
      }
      this.invalidateKnownStat(key);
      return true;
    });
    if (ok) {
      this.changed();
      this.checkExternal(key);
      this.options.onLocalWrite?.(key);
    }
    return ok;
  }

  /** Moves the document to Recently Deleted only if its hash is still `expect`. */
  async removeForSync(relative: string, expect: string): Promise<boolean> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    const ok = await this.queue.run(key, async () => {
      this.hashCache.delete(key);
      if (!(await this.moveToTrash(key, 'file', expect))) return false;
      this.invalidateKnownStat(key);
      return true;
    });
    if (ok) {
      this.changed();
      this.options.onLocalWrite?.('');
    }
    return ok;
  }

  async moveForSync(from: string, to: string, expect: string): Promise<boolean> {
    try {
      await this.rename(from, to, { expectHash: expect });
      return true;
    } catch (error) {
      if (error instanceof DocumentStoreError) return false;
      throw error;
    }
  }

  async conflictCopyForSync(relative: string, bytes: Uint8Array): Promise<string> {
    const key = this.key(relative);
    const copy = await this.claimConflictCopy(key, bytes);
    this.changedLocally();
    return copy;
  }

  private invalidateKnownStat(key: string): void {
    const k = this.known.get(key);
    if (k) k.stat = null;
  }

  /** After a sync write: tell the editor if its open document now differs from what it has. */
  private checkExternal(key: string): void {
    if (!this.known.has(key) || this.externalListeners.size === 0) return;
    void this.queue
      .run(key, async () => {
        const known = this.known.get(key);
        if (!known) return;
        const bytes = await this.bytesOrNull(key);
        if (!bytes) return;
        const hash = sha256Hex(bytes);
        if (hash === known.hash) return;
        const content = decodeUtf8(bytes);
        if (content === null) return; // not UTF-8: a later save goes to a conflict copy
        for (const l of this.externalListeners) l({ path: key, content, token: hash });
      })
      .catch((error: unknown) => console.error('Margin: external change check failed', error));
  }
}
