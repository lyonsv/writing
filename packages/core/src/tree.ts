/**
 * The document library as a tree, plus the pure path/name logic shared by
 * desktop, iOS (M6) and sync (M5). See docs/decisions/0008-library-model.md.
 */
import { conflictTimestamp } from './conflict';
import type { DocumentEntry, FolderEntry, LibraryEntry } from './document';
import { MARKDOWN_EXTENSION, basename, dirname, displayName, isMarkdownPath, isWithin, joinDocPath, utf8Length } from './paths';

export type LibrarySort = 'name' | 'modified';

export interface FolderNode extends FolderEntry {
  children: TreeNode[];
  /** Latest modification time of any document inside (0 if empty). */
  modifiedAt: number;
}
export type DocumentNode = DocumentEntry;
export type TreeNode = FolderNode | DocumentNode;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * Builds a tree from a flat list of entries at any depth. Missing ancestor
 * folders are synthesised, so a list of documents alone is enough.
 */
export function buildTree(entries: readonly LibraryEntry[], sort: LibrarySort = 'name'): TreeNode[] {
  const root: FolderNode = { kind: 'folder', path: '', name: '', children: [], modifiedAt: 0 };
  const folders = new Map<string, FolderNode>([['', root]]);

  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const node: FolderNode = { kind: 'folder', path, name: basename(path), children: [], modifiedAt: 0 };
    folders.set(path, node);
    folderFor(dirname(path)).children.push(node);
    return node;
  };

  for (const entry of entries) {
    if (entry.kind === 'folder') folderFor(entry.path);
    else folderFor(dirname(entry.path)).children.push({ ...entry });
  }

  const finish = (folder: FolderNode): void => {
    for (const child of folder.children) {
      if (child.kind === 'folder') finish(child);
      folder.modifiedAt = Math.max(folder.modifiedAt, child.modifiedAt);
    }
    folder.children = sortNodes(folder.children, sort);
  };
  finish(root);
  return root.children;
}

/** Folders first (by name), then documents by name or newest-first. */
export function sortNodes(nodes: readonly TreeNode[], sort: LibrarySort): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (sort === 'modified' && a.kind === 'document' && b.kind === 'document' && a.modifiedAt !== b.modifiedAt) {
      return b.modifiedAt - a.modifiedAt;
    }
    return byName(a, b);
  });
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Visible rows for a sidebar: children of expanded folders only. */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    const isOpen = node.kind === 'folder' && expanded.has(node.path);
    rows.push({ node, depth, expanded: isOpen });
    if (node.kind === 'folder' && isOpen) rows.push(...flattenTree(node.children, expanded, depth + 1));
  }
  return rows;
}

/** Every document in the tree, depth-first. */
export function allDocuments(nodes: readonly TreeNode[]): DocumentNode[] {
  const out: DocumentNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'document') out.push(n);
    else out.push(...allDocuments(n.children));
  }
  return out;
}

/** Folder paths that must be expanded for `path` to be visible. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  for (let p = dirname(path); p !== ''; p = dirname(p)) out.unshift(p);
  return out;
}

// ------------------------------------------------------------------ names

/**
 * Longest name a user may type, in UTF-8 bytes. The filesystem allows 255 per
 * name; we keep room for `.md` (3), a conflict-copy suffix
 * (` (conflict YYYY-MM-DD HHMM NN)`, ~31) and a uniqueness counter (` NN`),
 * so every name we derive from it still fits.
 */
export const MAX_NAME_BYTES = 200;

/**
 * Validates a single file or folder name typed by the user. Returns an error
 * message, or null if the name is fine.
 */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Name can’t be empty.';
  if (trimmed !== name) return 'Name can’t start or end with spaces.';
  if (name.startsWith('.')) return 'Name can’t start with a dot.';
  if (/[/\\:\0]/.test(name)) return 'Name can’t contain / \\ or :';
  if (utf8Length(name) > MAX_NAME_BYTES) return 'Name is too long.';
  return null;
}

/** The new path for renaming `path` to `name` in place. Documents keep/gain `.md`. */
export function renamedPath(path: string, name: string, kind: 'document' | 'folder'): string {
  const file = kind === 'document' && !isMarkdownPath(name) ? `${name}${MARKDOWN_EXTENSION}` : name;
  return joinDocPath(dirname(path), file);
}

/** The new path for moving `path` into `folder` ('' = root). */
export function movedPath(path: string, folder: string): string {
  return joinDocPath(folder, basename(path));
}

/** Whether moving `path` into `folder` is meaningful and allowed. */
export function canMoveInto(path: string, folder: string): boolean {
  if (dirname(path) === folder) return false; // already there
  return !isWithin(path, folder); // not into itself or a descendant
}

/**
 * If `path` is affected by renaming `from` → `to` (it is `from`, or lies
 * inside the folder `from`), returns its new path; otherwise null.
 */
export function rebasePath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (from !== '' && path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** `base`, or `base 2`, `base 3`… — the first not in `taken` (compared case-insensitively, like APFS). */
export function uniqueName(base: string, taken: Iterable<string>, extension = ''): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = `${base}${i > 1 ? ` ${i}` : ''}${extension}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * New documents are named by date: `2026-11-02.md`, then `2026-11-02 2.md`…
 * (ADR 0008). Returns the path inside `folder`.
 */
export function newDocumentPath(folder: string, date: Date, taken: Iterable<string>): string {
  const day = conflictTimestamp(date).slice(0, 10);
  return joinDocPath(folder, uniqueName(day, taken, MARKDOWN_EXTENSION));
}

export function newFolderPath(parent: string, taken: Iterable<string>): string {
  return joinDocPath(parent, uniqueName('New Folder', taken));
}

/** Names of the direct children of `folder` in a flat entry list. */
export function childNames(entries: readonly LibraryEntry[], folder: string): string[] {
  return entries.filter((e) => dirname(e.path) === folder).map((e) => basename(e.path));
}

// ------------------------------------------------------------------ quick open

export interface QuickOpenResult {
  path: string;
  title: string;
  score: number;
  /** Indices into `path` that matched, for highlighting. */
  matches: number[];
}

/**
 * Subsequence fuzzy match of `query` in `target` (case-insensitive). Higher
 * scores for consecutive runs, word starts and matches in the file name.
 * Returns null if not all query characters appear in order.
 */
export function fuzzyMatch(query: string, target: string): { score: number; matches: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return { score: 0, matches: [] };
  const t = target.toLowerCase();
  const nameStart = target.lastIndexOf('/') + 1;
  const matches: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    // Prefer an occurrence at a word start if one exists ahead.
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== ch) continue;
      if (found === -1) found = j;
      const boundary = j === 0 || /[\s/_\-.]/.test(t[j - 1]!);
      if (boundary || j === prev + 1) {
        found = j;
        break;
      }
    }
    if (found === -1) return null;
    const boundary = found === 0 || /[\s/_\-.]/.test(t[found - 1]!);
    score += 1;
    if (found === prev + 1) score += 5;
    if (boundary) score += 3;
    if (found >= nameStart) score += 2;
    matches.push(found);
    prev = found;
    ti = found + 1;
  }
  // Shorter targets win ties.
  score -= target.length * 0.01;
  return { score, matches };
}

/** Ranks documents for quick open. An empty query lists documents newest first. */
export function quickOpen(docs: readonly DocumentNode[], query: string, limit = 50): QuickOpenResult[] {
  if (query.trim() === '') {
    return [...docs]
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit)
      .map((d) => ({ path: d.path, title: displayName(d.path), score: 0, matches: [] }));
  }
  const results: QuickOpenResult[] = [];
  for (const d of docs) {
    const m = fuzzyMatch(query, d.path.replace(/\.md$/i, ''));
    if (m) results.push({ path: d.path, title: displayName(d.path), score: m.score, matches: m.matches });
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Flat recursive listing via `DocumentStore.list` (for stores without a native tree listing). */
export async function listAll(
  store: { list(folder?: string): Promise<LibraryEntry[]> },
  folder = '',
  limit = 50_000,
): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  const queue = [folder];
  while (queue.length > 0 && out.length < limit) {
    for (const entry of await store.list(queue.shift())) {
      out.push(entry);
      if (entry.kind === 'folder') queue.push(entry.path);
    }
  }
  return out;
}
