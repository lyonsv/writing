import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentStoreError, type ExternalChange } from '@margin/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NativeLibrary, TRASH_RETENTION_MS, sha256Hex } from '../src/local/library';
import { NodeFs } from './nodeFs';

let base: string;
let fs: NodeFs;
let lib: NativeLibrary;
let now: Date;
let external: ExternalChange[];
const enc = (s: string) => new TextEncoder().encode(s);

const file = (p: string) => path.join(base, 'Margin', p);
const put = (p: string, text: string | Uint8Array) => {
  mkdirSync(path.dirname(file(p)), { recursive: true });
  writeFileSync(file(p), text);
};
const get = (p: string) => (existsSync(file(p)) ? readFileSync(file(p), 'utf8') : null);

async function rejectCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof DocumentStoreError ? e.code : (e as Error).name;
  }
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'margin-native-'));
  fs = new NodeFs(base);
  now = new Date(2026, 10, 2, 14, 30);
  lib = new NativeLibrary({ fs, now: () => now });
  external = [];
  lib.onExternalChange((c) => external.push(c));
  await lib.init();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('NativeLibrary: paths', () => {
  it('refuses escapes, hidden names, non-.md documents and over-long names', async () => {
    for (const bad of ['../x.md', '/abs.md', 'a/../b.md', 'a\\b.md', '.hidden.md', 'notes/.x/y.md', 'x.txt', 'nul\0.md']) {
      expect(await rejectCode(lib.save(bad, 'x')), bad).toBe('invalid-path');
    }
    expect(await rejectCode(lib.save(`${'é'.repeat(127)}.md`, 'x'))).toBe('invalid-path'); // 257 bytes
    expect(await rejectCode(lib.save(`${'a/'.repeat(520)}x.md`, 'x'))).toBe('invalid-path'); // > 1024 bytes
    expect(await rejectCode(lib.createFolder('.git'))).toBe('invalid-path');
    expect(await lib.save(`${'é'.repeat(125)}.md`, 'ok')).toEqual({ status: 'saved', path: `${'é'.repeat(125)}.md` }); // 253 bytes
  });

  it('lists only folders and .md files, skipping dot-entries and temp files', async () => {
    put('a.md', 'a');
    put('notes/b.md', 'b');
    put('notes/.margin-abc.tmp', 'partial');
    put('.DS_Store', '');
    put('image.png', '');
    const { entries } = await lib.listTree();
    expect(entries.map((e) => `${e.kind}:${e.path}`).sort()).toEqual(['document:a.md', 'document:notes/b.md', 'folder:notes']);
  });

  it('init removes leftover temp files from an interrupted write, and nothing else', async () => {
    put('notes/.margin-abc123.tmp', 'partial');
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(file('notes/.margin-abc123.tmp'), old, old);
    put('notes/.margin-notes.md', 'user file?');
    put('keep.md', 'k');
    await new NativeLibrary({ fs }).init();
    expect(existsSync(file('notes/.margin-abc123.tmp'))).toBe(false);
    expect(get('notes/.margin-notes.md')).toBe('user file?');
    expect(get('keep.md')).toBe('k');
  });
});

describe('NativeLibrary: a second writer starting up (validator M8 LOW)', () => {
  it('init leaves a fresh temp file alone: it may be another tab’s write in progress', async () => {
    put('.margin-inflight1.tmp', 'being written right now');
    await new NativeLibrary({ fs }).init();
    expect(get('.margin-inflight1.tmp')).toBe('being written right now');
  });
});

describe('NativeLibrary: saving', () => {
  it('coalesces queued saves so the last requested text wins', async () => {
    const results = await Promise.all([lib.save('a.md', 'one'), lib.save('a.md', 'two'), lib.save('a.md', 'three')]);
    expect(results.map((r) => r.status)).toEqual(['superseded', 'superseded', 'saved']);
    expect(get('a.md')).toBe('three');
  });

  it('a failed write leaves the previous text intact and reports the failure', async () => {
    await lib.save('a.md', 'old');
    fs.faults.push({ op: 'writeAtomic', match: (p) => p.endsWith('a.md') });
    await expect(lib.save('a.md', 'new')).rejects.toThrow('injected');
    expect(get('a.md')).toBe('old');
    await lib.save('a.md', 'new'); // the SaveScheduler retries
    expect(get('a.md')).toBe('new');
  });

  it('keeps a BOM and opens non-UTF-8 files read-only', async () => {
    put('bom.md', '﻿hello');
    const doc = await lib.open('bom.md');
    expect(doc.content).toBe('﻿hello');
    await lib.save('bom.md', `${doc.content}!`);
    expect([...readFileSync(file('bom.md')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    put('latin.md', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const latin = await lib.open('latin.md');
    expect(latin.readOnly).toBe('not-utf8');
    expect(await rejectCode(lib.save('latin.md', 'x'))).toBe('invalid-path');
    expect([...readFileSync(file('latin.md'))]).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });

  it('open creates a missing document exclusively, never truncating one that exists', async () => {
    expect((await lib.open('new.md')).content).toBe('');
    put('there.md', 'text');
    expect((await lib.open('there.md')).content).toBe('text');
  });
});

describe('NativeLibrary: create, rename, move, delete', () => {
  it('createDocument never touches an existing file', async () => {
    put('a.md', 'precious');
    expect(await rejectCode(lib.createDocument('a.md'))).toBe('exists');
    expect(get('a.md')).toBe('precious');
    await lib.createDocument('b.md');
    expect(get('b.md')).toBe('');
  });

  it('rename and move never replace an existing destination (files and folders)', async () => {
    put('a.md', 'A');
    put('b.md', 'B');
    expect(await rejectCode(lib.rename('a.md', 'b.md'))).toBe('exists');
    expect([get('a.md'), get('b.md')]).toEqual(['A', 'B']);

    put('x/one.md', '1');
    put('y/two.md', '2');
    expect(await rejectCode(lib.rename('x', 'y'))).toBe('exists');
    expect(existsSync(file('y/x'))).toBe(false); // not moved *into* y (expo's Directory.move would)
    expect([get('x/one.md'), get('y/two.md')]).toEqual(['1', '2']);

    await lib.rename('x', 'z/x');
    expect(get('z/x/one.md')).toBe('1');
    expect(await rejectCode(lib.rename('z', 'z/x/inner'))).toBe('invalid-path');
  });

  it('case-only renames work and still refuse a distinct existing file', async () => {
    put('draft.md', 'd');
    await lib.rename('draft.md', 'Draft.md');
    expect(readdirSync(path.join(base, 'Margin'))).toContain('Draft.md');
    expect(readdirSync(path.join(base, 'Margin'))).not.toContain('draft.md');
    expect(get('Draft.md')).toBe('d');
  });

  it('a save racing a rename follows the document instead of recreating the old path', async () => {
    await lib.open('a.md');
    await lib.save('a.md', 'v1');
    await lib.rename('a.md', 'b.md');
    expect(await lib.save('a.md', 'v2')).toEqual({ status: 'saved', path: 'b.md' });
    expect(get('a.md')).toBeNull();
    expect(get('b.md')).toBe('v2');
  });

  it('delete moves to Recently Deleted; restore puts it back (or next to a newer file)', async () => {
    put('notes/a.md', 'first');
    await lib.delete('notes/a.md');
    expect(get('notes/a.md')).toBeNull();
    const [item] = await lib.listTrash();
    expect(item).toMatchObject({ originalPath: 'notes/a.md', kind: 'document' });
    put('notes/a.md', 'second');
    expect(await lib.restore(item!.id)).toBe('notes/a 2.md');
    expect([get('notes/a.md'), get('notes/a 2.md')]).toEqual(['second', 'first']);
    expect(await lib.listTrash()).toEqual([]);

    await lib.delete('notes');
    expect((await lib.listTree()).entries).toEqual([]);
    const [folder] = await lib.listTrash();
    expect(folder!.kind).toBe('folder');
    expect(await lib.restore(folder!.id)).toBe('notes');
    expect(get('notes/a 2.md')).toBe('first');
  });

  it('Recently Deleted is outside the library (never listed or synced) and purged after 30 days', async () => {
    put('a.md', 'x');
    await lib.delete('a.md');
    expect(existsSync(path.join(base, '.margin/trash'))).toBe(true);
    expect((await lib.listTree()).entries).toEqual([]);
    now = new Date(now.getTime() + TRASH_RETENTION_MS + 1000);
    await lib.purgeTrash();
    expect(await lib.listTrash()).toEqual([]);
  });

  it('a failed move to Recently Deleted leaves the document where it was', async () => {
    put('a.md', 'keep');
    fs.faults.push({ op: 'move', match: (p) => p.includes('.margin/trash') });
    await expect(lib.delete('a.md')).rejects.toThrow();
    expect(get('a.md')).toBe('keep');
  });
});

describe('NativeLibrary: sync guards and the open document', () => {
  it('writeForSync/removeForSync/moveForSync only act on the content they planned for', async () => {
    put('a.md', 'local');
    expect(await lib.writeForSync('a.md', enc('remote'), sha256Hex(enc('other')))).toBe(false);
    expect(await lib.writeForSync('a.md', enc('remote'), null)).toBe(false); // create-only, but it exists
    expect(get('a.md')).toBe('local');
    expect(await lib.removeForSync('a.md', sha256Hex(enc('other')))).toBe(false);
    expect(await lib.moveForSync('a.md', 'b.md', sha256Hex(enc('other')))).toBe(false);
    expect(get('a.md')).toBe('local');
    expect(await lib.writeForSync('a.md', enc('remote'), sha256Hex(enc('local')))).toBe(true);
    expect(get('a.md')).toBe('remote');
    expect(await lib.removeForSync('a.md', sha256Hex(enc('remote')))).toBe(true);
    expect(get('a.md')).toBeNull();
    expect((await lib.listTrash())[0]!.originalPath).toBe('a.md');
  });

  it('a sync download into the open document is reported; a dirty save goes to a conflict copy', async () => {
    await lib.open('a.md');
    await lib.save('a.md', 'mine v1');
    expect(await lib.writeForSync('a.md', enc('theirs'), sha256Hex(enc('mine v1')))).toBe(true);
    await lib.idle();
    expect(external).toEqual([{ path: 'a.md', content: 'theirs', token: sha256Hex(enc('theirs')) }]);
    // The editor had unsaved text: its save must not overwrite "theirs".
    const r = await lib.save('a.md', 'mine v2');
    expect(r).toEqual({ status: 'conflict', path: 'a.md', conflictPath: 'a (conflict 2026-11-02 1430).md' });
    expect(get('a.md')).toBe('theirs');
    expect(get('a (conflict 2026-11-02 1430).md')).toBe('mine v2');
    // Stragglers to the original path keep going to the same copy.
    await lib.save('a.md', 'mine v3');
    expect(get('a (conflict 2026-11-02 1430).md')).toBe('mine v3');
    expect(get('a.md')).toBe('theirs');
  });

  it('after the editor reloads external text, saves go to the path again', async () => {
    await lib.open('a.md');
    await lib.save('a.md', 'v1');
    await lib.writeForSync('a.md', enc('remote'), sha256Hex(enc('v1')));
    await lib.idle();
    expect(await lib.acknowledgeExternal('a.md', external[0]!.token)).toBe(true);
    expect(await lib.save('a.md', 'remote + edit')).toEqual({ status: 'saved', path: 'a.md' });
    expect(get('a.md')).toBe('remote + edit');
  });

  it('the hash cache never hides a change we made', async () => {
    await lib.save('a.md', 'one');
    expect((await lib.hashForSync('a.md'))!.hash).toBe(sha256Hex(enc('one')));
    await lib.save('a.md', 'two'); // same size, possibly same mtime
    expect((await lib.hashForSync('a.md'))!.hash).toBe(sha256Hex(enc('two')));
  });

  it('conflict copies are claimed exclusively and numbered', async () => {
    put('a (conflict 2026-11-02 1430).md', 'older copy');
    expect(await lib.conflictCopyForSync('a.md', enc('x'))).toBe('a (conflict 2026-11-02 1430 2).md');
    expect(get('a (conflict 2026-11-02 1430).md')).toBe('older copy');
  });
});
