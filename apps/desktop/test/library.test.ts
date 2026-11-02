import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSystemLibrary, OutsideRootError } from '../src/library';

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
