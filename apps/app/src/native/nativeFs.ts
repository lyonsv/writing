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
}
