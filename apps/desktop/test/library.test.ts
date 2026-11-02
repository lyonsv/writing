import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisallowedPathError, FileSystemLibrary, OutsideRootError } from '../src/library';

let base: string;
let root: string;
let lib: FileSystemLibrary;

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'margin-fs-'));
  root = path.join(base, 'Margin');
  lib = new FileSystemLibrary(root);
  await lib.init();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('FileSystemLibrary', () => {
  it('writes real .md files atomically and reads them back', async () => {
    await lib.write('notes/a.md', '# A');
    expect(readFileSync(path.join(root, 'notes/a.md'), 'utf8')).toBe('# A');
    expect(readdirSync(path.join(root, 'notes'))).toEqual(['a.md']);
    expect(await lib.read('notes/a.md')).toBe('# A');
    expect(await lib.read('missing.md')).toBeNull();
  });

  it('lists folders and markdown files, skipping dotfiles and other files', async () => {
    await lib.write('b.md', 'bb');
    await lib.createFolder('folder');
    writeFileSync(path.join(root, 'image.png'), '');
    writeFileSync(path.join(root, '.hidden.md'), '');
    const entries = await lib.list();
    expect(entries.map((e) => [e.kind, e.path])).toEqual([
      ['folder', 'folder'],
      ['document', 'b.md'],
    ]);
    expect(entries[1]).toMatchObject({ name: 'b', size: 2 });
  });

  it('renames without overwriting and deletes', async () => {
    await lib.write('a.md', '1');
    await lib.write('b.md', '2');
    await expect(lib.rename('a.md', 'b.md')).rejects.toMatchObject({ code: 'exists' });
    await lib.rename('a.md', 'sub/c.md');
    expect(await lib.read('sub/c.md')).toBe('1');
    await lib.delete('sub');
    expect(existsSync(path.join(root, 'sub'))).toBe(false);
  });

  it.each([
    ['../outside.md'],
    ['/etc/passwd'],
    ['notes/../../outside.md'],
    ['..\\outside.md'],
  ])('rejects %j', async (p) => {
    await expect(lib.write(p, 'x')).rejects.toBeInstanceOf(OutsideRootError);
    await expect(lib.read(p)).rejects.toBeInstanceOf(OutsideRootError);
    expect(existsSync(path.join(base, 'outside.md'))).toBe(false);
  });

  it('rejects absolute paths that point at a sibling of the root', async () => {
    await expect(lib.write(path.join(base, 'outside.md'), 'x')).rejects.toBeInstanceOf(OutsideRootError);
    expect(existsSync(path.join(base, 'outside.md'))).toBe(false);
  });

  it('refuses to delete the root itself', async () => {
    await expect(lib.delete('')).rejects.toBeInstanceOf(OutsideRootError);
  });

  it('rejects symlinks that escape the root', async () => {
    writeFileSync(path.join(base, 'secret.md'), 'secret');
    symlinkSync(base, path.join(root, 'escape'));
    await expect(lib.read('escape/secret.md')).rejects.toBeInstanceOf(OutsideRootError);
    await expect(lib.write('escape/new.md', 'x')).rejects.toBeInstanceOf(OutsideRootError);
    expect(existsSync(path.join(base, 'new.md'))).toBe(false);
  });
});

describe('FileSystemLibrary save pipeline', () => {
  const when = new Date(2026, 10, 2, 14, 30);

  it('later writes win even when an earlier, larger write is still in flight', async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all([lib.write('race.md', 'OLD'.repeat(3_000_000)), lib.write('race.md', 'NEW')]);
      expect(readFileSync(path.join(root, 'race.md'), 'utf8')).toBe('NEW');
    }
  });

  it('coalesces queued writes and reports superseded ones', async () => {
    const results = await Promise.all([lib.save('a.md', '1'), lib.save('a.md', '2'), lib.save('a.md', '3')]);
    expect(results.map((r) => r.status)).toEqual(['superseded', 'superseded', 'saved']);
    expect(readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('3');
  });

  it('only writes .md files and refuses hidden paths', async () => {
    for (const p of ['evil.sh', '.hidden', '.hidden.md', 'notes/.git/config.md', 'noext']) {
      await expect(lib.write(p, 'x'), p).rejects.toBeInstanceOf(DisallowedPathError);
    }
    await expect(lib.createFolder('.secret')).rejects.toBeInstanceOf(DisallowedPathError);
    await lib.write('a.md', 'x');
    await expect(lib.rename('a.md', 'a.sh')).rejects.toBeInstanceOf(DisallowedPathError);
    expect(readdirSync(root)).toEqual(['a.md']);
  });

  it('open creates a missing document exclusively and never truncates an existing one', async () => {
    expect(await lib.open('new.md')).toEqual({ path: 'new.md', content: '' });
    writeFileSync(path.join(root, 'existing.md'), 'keep me');
    expect(await lib.open('existing.md')).toEqual({ path: 'existing.md', content: 'keep me' });
    expect(readFileSync(path.join(root, 'existing.md'), 'utf8')).toBe('keep me');
  });

  it('never clobbers an external edit: our text goes to a conflict copy', async () => {
    const conflicted = new FileSystemLibrary(root, { now: () => when });
    await conflicted.init();
    writeFileSync(path.join(root, 'doc.md'), 'v1');
    await conflicted.open('doc.md');
    await conflicted.save('doc.md', 'v1 + ours');
    writeFileSync(path.join(root, 'doc.md'), 'v1 + ours + theirs');

    const result = await conflicted.save('doc.md', 'v1 + ours + more');
    expect(result).toEqual({ status: 'conflict', path: 'doc.md', conflictPath: 'doc (conflict 2026-11-02 1430).md' });
    expect(readFileSync(path.join(root, 'doc.md'), 'utf8')).toBe('v1 + ours + theirs');
    expect(readFileSync(path.join(root, 'doc (conflict 2026-11-02 1430).md'), 'utf8')).toBe('v1 + ours + more');

    // A straggling save to the original goes to the same copy, not a new one.
    await conflicted.save('doc.md', 'v1 + ours + more + more');
    expect(readFileSync(path.join(root, 'doc (conflict 2026-11-02 1430).md'), 'utf8')).toBe('v1 + ours + more + more');
    expect(readdirSync(root).filter((f) => f.includes('conflict'))).toHaveLength(1);

    // A second, independent conflict gets a numbered copy.
    await conflicted.open('doc.md');
    writeFileSync(path.join(root, 'doc.md'), 'theirs again');
    const second = await conflicted.save('doc.md', 'ours again');
    expect(second).toMatchObject({ conflictPath: 'doc (conflict 2026-11-02 1430 2).md' });
  });

  it('acknowledged external content becomes the new base', async () => {
    writeFileSync(path.join(root, 'doc.md'), 'v1');
    await lib.open('doc.md');
    writeFileSync(path.join(root, 'doc.md'), 'v2 external');
    const { createHash } = await import('node:crypto');
    const token = createHash('sha256').update('v2 external').digest('hex');
    expect(await lib.acknowledgeExternal('doc.md', 'stale-token')).toBe(false);
    expect(await lib.acknowledgeExternal('doc.md', token)).toBe(true);
    expect(await lib.save('doc.md', 'v2 external + local')).toEqual({ status: 'saved', path: 'doc.md' });
  });

  it('reports external changes to the open document, but not its own writes', async () => {
    const changes: string[] = [];
    const watched = new FileSystemLibrary(root, { onExternalChange: (c) => changes.push(c.content) });
    await watched.init();
    writeFileSync(path.join(root, 'w.md'), 'v1');
    await watched.open('w.md');
    await watched.save('w.md', 'ours');
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toEqual([]);
    writeFileSync(path.join(root, 'w.md'), 'theirs');
    await vi.waitFor(() => expect(changes).toEqual(['theirs']), { timeout: 3000 });
    watched.dispose();
  });

  it('rename never replaces an existing destination', async () => {
    await lib.write('a.md', 'A');
    await lib.write('b.md', 'B');
    await expect(lib.rename('a.md', 'b.md')).rejects.toMatchObject({ code: 'exists' });
    expect(readFileSync(path.join(root, 'b.md'), 'utf8')).toBe('B');
    await lib.createFolder('f1');
    await lib.createFolder('f2');
    await lib.write('f2/x.md', 'x');
    await expect(lib.rename('f1', 'f2')).rejects.toMatchObject({ code: 'exists' });
    expect(readFileSync(path.join(root, 'f2/x.md'), 'utf8')).toBe('x');
    await lib.rename('f1', 'f3');
    expect(existsSync(path.join(root, 'f3'))).toBe(true);
  });
});

describe('FileSystemLibrary without hard links (exFAT, network shares)', () => {
  const noLink = (errno: string) => async () =>
    Promise.reject(Object.assign(new Error(`link: ${errno}`), { code: errno }));

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])('creates, conflicts and renames without link() (%s)', async (errno) => {
    const l = new FileSystemLibrary(root, { link: noLink(errno), now: () => new Date(2026, 10, 2, 9, 0) });
    await l.init();
    expect(await l.open('new.md')).toEqual({ path: 'new.md', content: '' });
    await l.save('new.md', 'mine');
    writeFileSync(path.join(root, 'new.md'), 'theirs');
    expect(await l.save('new.md', 'mine 2')).toMatchObject({ status: 'conflict' });
    expect(readFileSync(path.join(root, 'new (conflict 2026-11-02 0900).md'), 'utf8')).toBe('mine 2');
    expect(readFileSync(path.join(root, 'new.md'), 'utf8')).toBe('theirs');

    await l.write('a.md', 'A');
    await l.write('b.md', 'B');
    await expect(l.rename('a.md', 'b.md')).rejects.toMatchObject({ code: 'exists' });
    expect(readFileSync(path.join(root, 'b.md'), 'utf8')).toBe('B');
    await l.rename('a.md', 'c.md');
    expect(readFileSync(path.join(root, 'c.md'), 'utf8')).toBe('A');
    expect(existsSync(path.join(root, 'a.md'))).toBe(false);
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    l.dispose();
  });

  it('propagates unrelated link() errors', async () => {
    const l = new FileSystemLibrary(root, { link: noLink('EIO') });
    await l.init();
    await expect(l.open('x.md')).rejects.toMatchObject({ code: 'EIO' });
  });
});

describe('FileSystemLibrary encodings', () => {
  it('opens non-UTF-8 files read-only and refuses to save them', async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    writeFileSync(path.join(root, 'latin1.md'), latin1);
    expect(await lib.open('latin1.md')).toEqual({ path: 'latin1.md', content: 'café\n', readOnly: 'not-utf8' });
    await expect(lib.save('latin1.md', 'café edited\n')).rejects.toBeInstanceOf(DisallowedPathError);
    expect(readFileSync(path.join(root, 'latin1.md')).equals(latin1)).toBe(true);
  });

  it('keeps CRLF bytes and a UTF-8 BOM intact on open', async () => {
    writeFileSync(path.join(root, 'crlf.md'), '﻿a\r\nb\r\n');
    expect(await lib.open('crlf.md')).toEqual({ path: 'crlf.md', content: '﻿a\r\nb\r\n' });
  });
});
