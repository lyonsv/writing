import { describe, expect, it } from 'vitest';
import {
  MemoryDocumentStore,
  allDocuments,
  ancestorsOf,
  buildTree,
  canMoveInto,
  childNames,
  flattenTree,
  fuzzyMatch,
  listAll,
  movedPath,
  newDocumentPath,
  newFolderPath,
  quickOpen,
  rebasePath,
  renamedPath,
  uniqueName,
  validateName,
  type LibraryEntry,
  type TreeNode,
} from '../src';

const doc = (path: string, modifiedAt = 0): LibraryEntry => ({
  kind: 'document',
  path,
  name: path.split('/').pop()!.replace(/\.md$/, ''),
  modifiedAt,
  size: 1,
});
const folder = (path: string): LibraryEntry => ({ kind: 'folder', path, name: path.split('/').pop()! });

const names = (nodes: TreeNode[]): unknown[] =>
  nodes.map((n) => (n.kind === 'folder' ? { [n.name]: names(n.children) } : n.name));

describe('buildTree', () => {
  const entries = [
    doc('b.md', 30),
    doc('A.md', 10),
    doc('notes/z.md', 50),
    doc('notes/deep/x.md', 5),
    folder('empty'),
    folder('notes'),
    doc('Zed/one.md', 1), // ancestor folder not listed: synthesised
    doc('item 10.md', 20),
    doc('item 9.md', 40),
  ];

  it('nests, puts folders first and sorts naturally by name', () => {
    expect(names(buildTree(entries))).toEqual([
      { empty: [] },
      { notes: [{ deep: ['x'] }, 'z'] },
      { Zed: ['one'] },
      'A',
      'b',
      'item 9',
      'item 10',
    ]);
  });

  it('sorts documents newest first by modified date, folders still by name', () => {
    expect(names(buildTree(entries, 'modified'))).toEqual([
      { empty: [] },
      { notes: [{ deep: ['x'] }, 'z'] },
      { Zed: ['one'] },
      'item 9',
      'b',
      'item 10',
      'A',
    ]);
  });

  it('rolls up folder modification times', () => {
    const notes = buildTree(entries).find((n) => n.path === 'notes')!;
    expect(notes.modifiedAt).toBe(50);
  });

  it('flattens only expanded folders, with depth', () => {
    const tree = buildTree(entries);
    const rows = flattenTree(tree, new Set(['notes', 'notes/deep']));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.node.name}${r.expanded ? '/' : ''}`)).toEqual([
      'empty',
      'notes/',
      '  deep/',
      '    x',
      '  z',
      'Zed',
      'A',
      'b',
      'item 9',
      'item 10',
    ]);
    expect(allDocuments(tree).map((d) => d.path)).toContain('notes/deep/x.md');
    expect(ancestorsOf('notes/deep/x.md')).toEqual(['notes', 'notes/deep']);
  });
});

describe('names and paths', () => {
  it.each([
    ['', 'empty'],
    [' lead', 'spaces'],
    ['.hidden', 'dot'],
    ['a/b', '/'],
    ['a:b', ':'],
    ['x'.repeat(201), 'long'],
  ])('rejects %j', (name, why) => {
    expect(validateName(name), why).not.toBeNull();
  });

  it('accepts ordinary names', () => {
    expect(validateName('My draft (v2) — final')).toBeNull();
  });

  it('renames in place, keeping .md for documents', () => {
    expect(renamedPath('notes/a.md', 'b', 'document')).toBe('notes/b.md');
    expect(renamedPath('notes/a.md', 'b.md', 'document')).toBe('notes/b.md');
    expect(renamedPath('notes/old', 'new', 'folder')).toBe('notes/new');
  });

  it('moves into folders, refusing self/descendant/no-op moves', () => {
    expect(movedPath('notes/a.md', 'archive')).toBe('archive/a.md');
    expect(movedPath('notes/a.md', '')).toBe('a.md');
    expect(canMoveInto('notes/a.md', 'archive')).toBe(true);
    expect(canMoveInto('notes/a.md', 'notes')).toBe(false);
    expect(canMoveInto('notes', 'notes/sub')).toBe(false);
    expect(canMoveInto('notes', 'notes')).toBe(false);
    expect(canMoveInto('notes', 'notes2')).toBe(true);
  });

  it('rebases paths affected by a rename or move', () => {
    expect(rebasePath('a.md', 'a.md', 'b.md')).toBe('b.md');
    expect(rebasePath('notes/x/a.md', 'notes', 'archive/notes')).toBe('archive/notes/x/a.md');
    expect(rebasePath('notes2/a.md', 'notes', 'n')).toBeNull();
    expect(rebasePath('other.md', 'a.md', 'b.md')).toBeNull();
  });

  it('picks unique names case-insensitively', () => {
    expect(uniqueName('Draft', ['draft.md'], '.md')).toBe('Draft 2.md');
    expect(uniqueName('Draft', ['Draft.md', 'Draft 2.md'], '.md')).toBe('Draft 3.md');
    expect(uniqueName('New Folder', [])).toBe('New Folder');
  });

  it('names new documents by date and folders generically', () => {
    const when = new Date(2026, 10, 2, 9, 30);
    expect(newDocumentPath('', when, [])).toBe('2026-11-02.md');
    expect(newDocumentPath('notes', when, ['2026-11-02.md'])).toBe('notes/2026-11-02 2.md');
    expect(newFolderPath('notes', ['New Folder'])).toBe('notes/New Folder 2');
    expect(childNames([doc('a.md'), doc('n/b.md'), folder('n')], '')).toEqual(['a.md', 'n']);
  });
});

describe('quick open', () => {
  const docs = [
    doc('Ideas.md', 1),
    doc('projects/margin/roadmap.md', 3),
    doc('projects/margin/ideas for later.md', 2),
    doc('journal/2026-11-02.md', 4),
  ].map((d) => d as Extract<LibraryEntry, { kind: 'document' }>);

  it('matches subsequences and reports match indices', () => {
    expect(fuzzyMatch('rdmp', 'projects/margin/roadmap')).toMatchObject({ matches: [16, 19, 20, 22] }) // r at the word start, then d, m(consecutive), p;
    expect(fuzzyMatch('xyz', 'roadmap')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, matches: [] });
  });

  it('ranks file-name and word-start matches higher', () => {
    expect(quickOpen(docs, 'ideas').map((r) => r.path)).toEqual(['Ideas.md', 'projects/margin/ideas for later.md']);
    expect(quickOpen(docs, 'mar road')[0]!.path).toBe('projects/margin/roadmap.md');
    expect(quickOpen(docs, 'jour 11')[0]!.title).toBe('2026-11-02');
  });

  it('lists recent documents for an empty query', () => {
    expect(quickOpen(docs, '  ').map((r) => r.title)).toEqual(['2026-11-02', 'roadmap', 'ideas for later', 'Ideas']);
  });
});

describe('listAll', () => {
  it('lists a DocumentStore recursively', async () => {
    const store = new MemoryDocumentStore();
    await store.write('a.md', '');
    await store.write('n/b.md', '');
    await store.write('n/m/c.md', '');
    expect((await listAll(store)).map((e) => e.path).sort()).toEqual(['a.md', 'n', 'n/b.md', 'n/m', 'n/m/c.md']);
  });
});
