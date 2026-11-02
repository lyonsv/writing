import 'fake-indexeddb/auto';

import { DocumentStoreError, type ExternalChange } from '@margin/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { NativeLibrary, sha256Hex } from '../src/local/library';
import { FsExistsError } from '../src/local/nativeFs';
import { IdbFs, openMarginDb } from '../src/web/idbFs';
import { LEGACY_BACKUP_KEY, LEGACY_LIBRARY_KEY, migrateLocalStorage } from '../src/web/migrate';

let n = 0;
let fs: IdbFs;
let lib: NativeLibrary;
const enc = (s: string) => new TextEncoder().encode(s);
const text = async (p: string) => new TextDecoder().decode(await fs.readBytes(`Margin/${p}`));

beforeEach(async () => {
  fs = new IdbFs(await openMarginDb(`test-${++n}`));
  lib = new NativeLibrary({ fs, now: () => new Date(2026, 10, 2, 14, 30) });
  await lib.init();
});

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e instanceof DocumentStoreError ? e.code : (e as Error).name;
  }
  return undefined;
}

describe('IdbFs: the NativeFs contract on IndexedDB', () => {
  it('writes atomically, lists by parent, stats', async () => {
    await fs.mkdir('a/b');
    await fs.writeAtomic('a/b/x.md', enc('one'));
    await fs.writeAtomic('a/b/x.md', enc('two'));
    expect(new TextDecoder().decode(await fs.readBytes('a/b/x.md'))).toBe('two');
    expect(await fs.list('a')).toEqual([{ name: 'b', kind: 'dir' }]);
    expect(await fs.stat('a/b/x.md')).toMatchObject({ kind: 'file', size: 3 });
    expect(await fs.stat('nope')).toBeNull();
  });

  it('refuses writes into a missing folder or over a folder', async () => {
    await expect(fs.writeAtomic('missing/x.md', enc('x'))).rejects.toThrow();
    await fs.mkdir('d');
    await expect(fs.writeAtomic('d', enc('x'))).rejects.toThrow();
  });

  it('move never replaces, moves whole folders atomically, and refuses moving into itself', async () => {
    await fs.mkdir('src/inner');
    await fs.writeAtomic('src/inner/a.md', enc('a'));
    await fs.writeAtomic('taken.md', enc('t'));
    await expect(fs.move('src/inner/a.md', 'taken.md')).rejects.toBeInstanceOf(FsExistsError);
    expect(new TextDecoder().decode(await fs.readBytes('taken.md'))).toBe('t');
    await fs.mkdir('dst');
    await expect(fs.move('src', 'dst')).rejects.toBeInstanceOf(FsExistsError); // not nested into dst
    await fs.move('src', 'dst/moved');
    expect(await fs.stat('src')).toBeNull();
    expect(new TextDecoder().decode(await fs.readBytes('dst/moved/inner/a.md'))).toBe('a');
    await expect(fs.move('dst/moved', 'dst/moved/inner/x')).rejects.toThrow();
  });

  it('remove deletes a subtree only', async () => {
    await fs.mkdir('a/b');
    await fs.mkdir('ab');
    await fs.writeAtomic('a/b/x.md', enc('x'));
    await fs.writeAtomic('ab/y.md', enc('y'));
    await fs.remove('a');
    expect(await fs.stat('a/b/x.md')).toBeNull();
    expect(await fs.stat('ab/y.md')).not.toBeNull();
  });

  it('concurrent creates of the same path: exactly one wins', async () => {
    await fs.mkdir('c');
    await fs.writeAtomic('c/t1', enc('1'));
    await fs.writeAtomic('c/t2', enc('2'));
    const results = await Promise.allSettled([fs.move('c/t1', 'c/x.md'), fs.move('c/t2', 'c/x.md')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('NativeLibrary on IndexedDB (the web/PWA store)', () => {
  it('saves coalesce; rename never replaces; conflict copy when sync changed the open document', async () => {
    const r = await Promise.all([lib.save('a.md', '1'), lib.save('a.md', '2'), lib.save('a.md', '3')]);
    expect(r.at(-1)).toEqual({ status: 'saved', path: 'a.md' });
    expect(await text('a.md')).toBe('3');
    await lib.save('b.md', 'B');
    expect(await code(lib.rename('a.md', 'b.md'))).toBe('exists');

    const changes: ExternalChange[] = [];
    lib.onExternalChange((c) => changes.push(c));
    await lib.open('a.md');
    expect(await lib.writeForSync('a.md', enc('remote'), sha256Hex(enc('3')))).toBe(true);
    await lib.idle();
    expect(changes.map((c) => c.content)).toEqual(['remote']);
    expect(await lib.save('a.md', 'mine')).toMatchObject({ status: 'conflict', conflictPath: 'a (conflict 2026-11-02 1430).md' });
    expect(await text('a.md')).toBe('remote');
    expect(await text('a (conflict 2026-11-02 1430).md')).toBe('mine');
  });

  it('delete goes to Recently Deleted and restores; path rules apply', async () => {
    await lib.save('notes/x.md', 'x');
    await lib.delete('notes/x.md');
    const [item] = await lib.listTrash();
    expect(await lib.restore(item!.id)).toBe('notes/x.md');
    expect(await text('notes/x.md')).toBe('x');
    for (const bad of ['../x.md', '.h.md', 'x.txt']) expect(await code(lib.save(bad, 'x'))).toBe('invalid-path');
  });

  it('migrates the old localStorage library once, never overwriting, keeping a backup', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    await lib.save('clash.md', 'already here');
    const legacy = {
      docs: { 'old.md': { content: 'from localStorage', modifiedAt: 1 }, 'f/deep.md': { content: 'deep', modifiedAt: 1 }, 'clash.md': { content: 'old clash', modifiedAt: 1 }, '../evil.md': { content: 'x' } },
      folders: ['f', 'empty'],
    };
    store.set(LEGACY_LIBRARY_KEY, JSON.stringify(legacy));
    const result = await migrateLocalStorage(lib, storage);
    expect(result!.migrated.sort()).toEqual(['f/deep.md', 'old.md']);
    expect(result!.skipped.sort()).toEqual(['../evil.md', 'clash.md']);
    expect(await text('old.md')).toBe('from localStorage');
    expect(await text('clash.md')).toBe('already here');
    expect(store.has(LEGACY_LIBRARY_KEY)).toBe(false);
    expect(JSON.parse(store.get(LEGACY_BACKUP_KEY)!)).toEqual(legacy);
    expect(await migrateLocalStorage(lib, storage)).toBeNull(); // once
  });
});
