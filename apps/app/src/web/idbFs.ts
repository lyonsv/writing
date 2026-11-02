import { FsExistsError, type FsStat, type NativeFs } from '../local/nativeFs';

/**
 * `NativeFs` on IndexedDB, for the hosted web app / iPhone PWA (ADR 0020).
 * The same `NativeLibrary` runs on top, so the web gets the iOS semantics:
 * per-path queue, coalesced saves, no-replace create/rename, conflict copies,
 * Recently Deleted, the core path rules.
 *
 * One object store of entries keyed by path (`Margin/notes/a.md`), with a
 * `parent` index for listings. **Every operation is a single IndexedDB
 * transaction**, so a write replaces a file atomically, and a move checks the
 * target and moves a whole folder subtree all-or-nothing. That holds across
 * browser tabs too (IndexedDB serialises overlapping readwrite transactions),
 * which a check-then-act in JS couldn't guarantee.
 *
 * We chose IndexedDB over OPFS: OPFS writes from the main thread need
 * `createWritable()` (Safari 26+ only; older iOS has only worker-side sync
 * access handles) and offer no multi-file transaction, so a folder move or an
 * exclusive create would need our own journal. IndexedDB is in every iOS
 * Safari version that can install a web app, and ships atomic transactions.
 */

interface Entry {
  path: string;
  parent: string;
  kind: 'file' | 'dir';
  bytes?: Uint8Array;
  size: number;
  modifiedAt: number;
}

const STORE = 'entries';

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const clean = (p: string) => p.split('/').filter(Boolean).join('/');
/** All keys strictly below `p`. */
const below = (p: string) => IDBKeyRange.bound(`${p}/`, `${p}/￿`);
/** Millisecond time plus a random fraction, so (size, mtime) never repeats across writes, even from two tabs. */
const stamp = () => Date.now() + Math.random();

const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function openMarginDb(name = 'margin', factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, { keyPath: 'path' });
      store.createIndex('parent', 'parent');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

export class IdbFs implements NativeFs {
  constructor(private readonly db: IDBDatabase) {}

  /** Runs `fn` in one transaction; resolves after the transaction commits (not just when `fn` returns). */
  private tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result: T;
      let failed: unknown;
      fn(store).then(
        (r) => {
          result = r;
        },
        (e: unknown) => {
          failed = e;
          try {
            t.abort();
          } catch {
            /* already finished */
          }
        },
      );
      t.oncomplete = () => (failed !== undefined ? reject(failed) : resolve(result));
      t.onabort = () => reject(failed ?? t.error ?? new Error('transaction aborted'));
      t.onerror = () => undefined; // onabort follows
    });
  }

  private static async isDir(store: IDBObjectStore, p: string): Promise<boolean> {
    if (p === '') return true;
    const e = (await req(store.get(p))) as Entry | undefined;
    return e?.kind === 'dir';
  }

  async stat(path: string): Promise<FsStat | null> {
    const p = clean(path);
    if (p === '') return { kind: 'dir', size: 0, modifiedAt: 0 };
    return this.tx('readonly', async (store) => {
      const e = (await req(store.get(p))) as Entry | undefined;
      return e ? { kind: e.kind, size: e.size, modifiedAt: e.modifiedAt } : null;
    });
  }

  async list(dir: string) {
    const p = clean(dir);
    return this.tx('readonly', async (store) => {
      const entries = (await req(store.index('parent').getAll(p))) as Entry[];
      return entries.map((e) => ({ name: nameOf(e.path), kind: e.kind }));
    });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const p = clean(path);
    return this.tx('readonly', async (store) => {
      const e = (await req(store.get(p))) as Entry | undefined;
      if (!e || e.kind !== 'file') throw new Error(`${p} does not exist`);
      return new Uint8Array(e.bytes ?? new Uint8Array());
    });
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const p = clean(path);
    const copy = new Uint8Array(bytes); // never store a view the caller may reuse
    await this.tx('readwrite', async (store) => {
      if (!(await IdbFs.isDir(store, parentOf(p)))) throw new Error(`folder ${parentOf(p)} does not exist`);
      const e = (await req(store.get(p))) as Entry | undefined;
      if (e?.kind === 'dir') throw new Error(`${p} is a folder`);
      await req(store.put({ path: p, parent: parentOf(p), kind: 'file', bytes: copy, size: copy.length, modifiedAt: stamp() } satisfies Entry));
    });
  }

  /** Compare-and-write in one transaction (other tabs can't write in between; validator M8 MEDIUM). */
  async writeIf(path: string, bytes: Uint8Array, accept: (current: string | null) => boolean, hash: (b: Uint8Array) => string): Promise<boolean> {
    const p = clean(path);
    const copy = new Uint8Array(bytes);
    return this.tx('readwrite', async (store) => {
      if (!(await IdbFs.isDir(store, parentOf(p)))) throw new Error(`folder ${parentOf(p)} does not exist`);
      const e = (await req(store.get(p))) as Entry | undefined;
      if (e?.kind === 'dir') return false;
      if (!accept(e ? hash(new Uint8Array(e.bytes ?? new Uint8Array())) : null)) return false;
      await req(store.put({ path: p, parent: parentOf(p), kind: 'file', bytes: copy, size: copy.length, modifiedAt: stamp() } satisfies Entry));
      return true;
    });
  }

  async moveIf(from: string, to: string, accept: (current: string | null) => boolean, hash: (b: Uint8Array) => string): Promise<boolean> {
    return this.moveImpl(from, to, (src) => (src.kind === 'file' ? accept(hash(new Uint8Array(src.bytes ?? new Uint8Array()))) : false));
  }

  async move(from: string, to: string): Promise<void> {
    await this.moveImpl(from, to, () => true);
  }

  private async moveImpl(from: string, to: string, accept: (src: Entry) => boolean): Promise<boolean> {
    const a = clean(from);
    const b = clean(to);
    return this.tx('readwrite', async (store) => {
      const src = (await req(store.get(a))) as Entry | undefined;
      if (!src) throw new Error(`${a} does not exist`);
      if (!accept(src)) return false;
      if (await req(store.get(b))) throw new FsExistsError(b);
      if (!(await IdbFs.isDir(store, parentOf(b)))) throw new Error(`folder ${parentOf(b)} does not exist`);
      if (b === a || b.startsWith(`${a}/`)) throw new Error('cannot move a folder into itself');
      const moved = [src, ...(src.kind === 'dir' ? ((await req(store.getAll(below(a)))) as Entry[]) : [])];
      for (const e of moved) {
        const next = b + e.path.slice(a.length);
        await req(store.delete(e.path));
        await req(store.put({ ...e, path: next, parent: parentOf(next) }));
      }
      return true;
    });
  }

  async mkdir(path: string): Promise<void> {
    const p = clean(path);
    if (p === '') return;
    await this.tx('readwrite', async (store) => {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const q = parts.slice(0, i).join('/');
        const e = (await req(store.get(q))) as Entry | undefined;
        if (e?.kind === 'file') throw new Error(`${q} is a file`);
        if (!e) await req(store.put({ path: q, parent: parentOf(q), kind: 'dir', size: 0, modifiedAt: stamp() } satisfies Entry));
      }
    });
  }

  async remove(path: string): Promise<void> {
    const p = clean(path);
    if (p === '') throw new Error('refusing to remove the root');
    await this.tx('readwrite', async (store) => {
      await req(store.delete(p));
      await req(store.delete(below(p)));
    });
  }
}
