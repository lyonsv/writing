import type { LibraryEntry } from './document';

/**
 * Platform-neutral access to the user's library of markdown files.
 *
 * All paths are library-relative (see `normalizeDocPath`). Implementations:
 * - Electron: IPC to the main process, which reads/writes real `.md` files.
 * - Web: localStorage.
 * - Native: stub until M5 (expo-file-system).
 * - Tests: `MemoryDocumentStore`.
 */
export interface DocumentStore {
  /** Direct children of `folder` (default: the root), folders first. */
  list(folder?: string): Promise<LibraryEntry[]>;
  /** Returns the document's text, or `null` if it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Creates or overwrites a document. Parent folders are created as needed. */
  write(path: string, content: string): Promise<void>;
  /** Moves a document or folder. Fails if `to` already exists. */
  rename(from: string, to: string): Promise<void>;
  /** Deletes a document, or a folder and everything in it. */
  delete(path: string): Promise<void>;
  /** Creates a folder (and any missing parents). No-op if it exists. */
  createFolder(path: string): Promise<void>;
}

export class DocumentStoreError extends Error {
  constructor(
    readonly code: 'not-found' | 'exists' | 'invalid-path' | 'not-a-folder' | 'changed',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentStoreError';
  }
}
