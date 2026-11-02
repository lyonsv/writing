import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentStoreError, InvalidPathError, MemoryDocumentStore, byteLength, createDocument } from '../src';

let clock = 0;
let store: MemoryDocumentStore;

beforeEach(() => {
  clock = 1000;
  store = new MemoryDocumentStore(undefined, { now: () => clock++ });
});

describe('MemoryDocumentStore', () => {
  it('writes and reads documents, creating parent folders', async () => {
    await store.write('notes/ideas/a.md', 'hello');
    expect(await store.read('notes/ideas/a.md')).toBe('hello');
    expect(await store.read('missing.md')).toBeNull();
    expect(await store.list()).toEqual([{ kind: 'folder', path: 'notes', name: 'notes' }]);
    expect(await store.list('notes')).toEqual([{ kind: 'folder', path: 'notes/ideas', name: 'ideas' }]);
    expect(await store.list('notes/ideas')).toEqual([
      { kind: 'document', path: 'notes/ideas/a.md', name: 'a', modifiedAt: 1000, size: 5 },
    ]);
  });

  it('lists folders before documents, alphabetically', async () => {
    await store.write('b.md', '');
    await store.write('A.md', '');
    await store.createFolder('zeta');
    expect((await store.list()).map((e) => e.path)).toEqual(['zeta', 'A.md', 'b.md']);
  });

  it('renames documents and folders', async () => {
    await store.write('notes/a.md', 'x');
    await store.write('notes/sub/b.md', 'y');
    await store.rename('notes/a.md', 'archive/a.md');
    expect(await store.read('archive/a.md')).toBe('x');
    await store.rename('notes', 'old');
    expect(await store.read('old/sub/b.md')).toBe('y');
    expect(await store.read('notes/sub/b.md')).toBeNull();
    await expect(store.list('notes')).rejects.toBeInstanceOf(DocumentStoreError);
  });

  it('refuses to overwrite on rename or move a folder into itself', async () => {
    await store.write('a.md', '1');
    await store.write('b.md', '2');
    await expect(store.rename('a.md', 'b.md')).rejects.toMatchObject({ code: 'exists' });
    await store.createFolder('f');
    await expect(store.rename('f', 'f/g')).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(store.rename('nope.md', 'c.md')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('deletes documents and folders recursively', async () => {
    await store.write('f/a.md', '1');
    await store.write('f/g/b.md', '2');
    await store.delete('f/a.md');
    expect(await store.read('f/a.md')).toBeNull();
    await store.delete('f');
    expect(await store.list()).toEqual([]);
    await expect(store.delete('f')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects paths that escape the root', async () => {
    await expect(store.write('../x.md', '')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(store.read('/etc/passwd')).rejects.toBeInstanceOf(InvalidPathError);
  });

  it('round-trips through a snapshot and notifies on change', async () => {
    const snapshots: unknown[] = [];
    const s = new MemoryDocumentStore(undefined, { onChange: (snap) => snapshots.push(snap) });
    await s.write('a/b.md', 'hi');
    expect(snapshots).toHaveLength(1);
    const restored = new MemoryDocumentStore(s.snapshot());
    expect(await restored.read('a/b.md')).toBe('hi');
    expect((await restored.list()).map((e) => e.path)).toEqual(['a']);
  });
});

describe('document model', () => {
  it('normalises paths on creation', () => {
    expect(createDocument('notes//a.md', 'x', 5)).toEqual({ path: 'notes/a.md', content: 'x', modifiedAt: 5 });
    expect(() => createDocument('../a.md')).toThrow(InvalidPathError);
  });

  it('computes UTF-8 byte length', () => {
    expect(byteLength('a')).toBe(1);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('—')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});
