import { basename, displayName, normalizeDocPath } from './paths';

/** An entry in the library tree. */
export type LibraryEntry =
  | {
      kind: 'document';
      /** Library-relative path, e.g. `notes/draft.md`. */
      path: string;
      name: string;
      /** Milliseconds since epoch. */
      modifiedAt: number;
      size: number;
    }
  | {
      kind: 'folder';
      path: string;
      name: string;
    };

export type DocumentEntry = Extract<LibraryEntry, { kind: 'document' }>;
export type FolderEntry = Extract<LibraryEntry, { kind: 'folder' }>;

/** A document loaded into memory. */
export interface MarginDocument {
  path: string;
  content: string;
  modifiedAt: number;
}

export function createDocument(path: string, content = '', modifiedAt = Date.now()): MarginDocument {
  return { path: normalizeDocPath(path), content, modifiedAt };
}

export function documentEntry(path: string, content: string, modifiedAt: number): DocumentEntry {
  return {
    kind: 'document',
    path,
    name: displayName(path),
    modifiedAt,
    size: byteLength(content),
  };
}

export function folderEntry(path: string): FolderEntry {
  return { kind: 'folder', path, name: basename(path) };
}

/** Folders first, then documents, each alphabetically (case-insensitive). */
export function sortEntries<T extends LibraryEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/** UTF-8 byte length, without depending on DOM or Node globals. */
export function byteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
