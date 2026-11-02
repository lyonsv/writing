/**
 * The few filesystem operations the iOS library needs, over paths relative to
 * the app's documents directory ('/'-separated, already validated by the
 * caller). Implemented by `expoFs.ts` (expo-file-system) on iOS and by
 * `test/nodeFs.ts` in unit tests, so the library logic is tested without a
 * device. See docs/decisions/0015-ios-storage.md.
 */
export interface FsStat {
  kind: 'file' | 'dir';
  size: number;
  /** Milliseconds since epoch. */
  modifiedAt: number;
}

export class FsExistsError extends Error {
  readonly code = 'exists';
  constructor(path: string) {
    super(`${path} already exists`);
    this.name = 'FsExistsError';
  }
}

export interface NativeFs {
  stat(path: string): Promise<FsStat | null>;
  /** Names in a directory (exact on-disk spelling). Empty if it doesn't exist. */
  list(dir: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }>>;
  /** Throws if the file doesn't exist. */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Replaces (or creates) `path` so that a crash leaves either the old or the
   * new bytes, never a mix: the bytes go to a temporary file which is then
   * renamed over the target.
   */
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Renames a file or directory. Never replaces anything: throws `FsExistsError`
   * if `to` exists (checked and moved without yielding to other JS, so no other
   * operation of ours can slip in between). The parent of `to` must exist.
   */
  move(from: string, to: string): Promise<void>;
  /** Creates a directory and any missing parents; fine if it exists. */
  mkdir(path: string): Promise<void>;
  /** Removes a file or a directory tree. Fine if it doesn't exist. */
  remove(path: string): Promise<void>;
  /**
   * Optional, for stores with more than one writer (IndexedDB shared by browser
   * tabs): compare and act as ONE atomic step. `accept` gets the current file's
   * hash (`hash` of its bytes; null if absent) inside the transaction; the write
   * or move happens only if it returns true. Single-writer stores (iOS, tests)
   * omit these and the library's per-path queue makes check-then-act atomic.
   */
  writeIf?(path: string, bytes: Uint8Array, accept: (current: string | null) => boolean, hash: (b: Uint8Array) => string): Promise<boolean>;
  /** Like `move` (never replaces; FsExistsError), but only if `accept(hash of from)`. */
  moveIf?(from: string, to: string, accept: (current: string | null) => boolean, hash: (b: Uint8Array) => string): Promise<boolean>;
}
