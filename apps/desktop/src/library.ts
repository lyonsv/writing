import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import {
  DocumentStoreError,
  conflictCopyPath,
  documentEntry,
  folderEntry,
  isHiddenPath,
  isMarkdownPath,
  joinDocPath,
  normalizeDocPath,
  sortEntries,
  type DocumentStore,
  type ExternalChange,
  type LibraryEntry,
  type OpenedDocument,
  type SaveResult,
} from '@margin/core';

import { SerialQueue } from './serialQueue';

/** Thrown when a requested path would resolve outside the library root. */
export class OutsideRootError extends Error {
  constructor(requested: string) {
    super(`Path is outside the library root: ${JSON.stringify(requested)}`);
    this.name = 'OutsideRootError';
  }
}

/** Thrown for paths inside the root that Margin refuses to touch (non-.md, hidden). */
export class DisallowedPathError extends Error {
  constructor(requested: string, reason: string) {
    super(`Path not allowed (${reason}): ${JSON.stringify(requested)}`);
    this.name = 'DisallowedPathError';
  }
}

interface Version {
  hash: string;
  mtimeMs: number;
  size: number;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
}

const hashOf = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// ignoreBOM: keep a leading U+FEFF in the text so it is written back unchanged.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decodes UTF-8, or returns null if the bytes aren't valid UTF-8. */
function decodeUtf8(buf: Buffer): string | null {
  try {
    return strictUtf8.decode(buf);
  } catch {
    return null;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  // Persist the rename/link itself. Not supported everywhere; best effort.
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* ignore */
  }
}

/** Writes `content` to a fresh temp file next to `target` and fsyncs it. Returns the temp path. */
async function writeTemp(target: string, content: string): Promise<string> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o644);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  return tmp;
}

/** errno codes meaning "this filesystem can't hard-link" (exFAT, FAT, SMB/NFS shares…). */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Moves `src` to `dst` without ever replacing an existing `dst`.
 * Preferred: `link()` (fails atomically with EEXIST) then unlink `src`.
 * Fallback for filesystems without hard links: claim `dst` exclusively with an
 * `O_EXCL` create, then `rename()` over our own empty placeholder.
 */
async function moveNoReplace(src: string, dst: string, link: LinkFn): Promise<void> {
  try {
    await link(src, dst);
    await fs.unlink(src);
    return;
  } catch (error) {
    if (!NO_HARDLINK_CODES.has(code(error) ?? '')) throw error;
  }
  const claim = await fs.open(dst, 'wx'); // EEXIST if anything is there
  await claim.close();
  try {
    await fs.rename(src, dst);
  } catch (error) {
    await fs.rm(dst, { force: true });
    throw error;
  }
}

export type LinkFn = (existingPath: string, newPath: string) => Promise<void>;

export interface LibraryOptions {
  now?: () => Date;
  /** Hard-link implementation; injectable so tests can simulate exFAT/network shares. */
  link?: LinkFn;
  /** Called when a watched document changes on disk without us writing it. */
  onExternalChange?: (change: ExternalChange) => void;
}

/**
 * A `DocumentStore` backed by real `.md` files under `root`, running in the
 * Electron main process. See docs/decisions/0006-save-pipeline.md.
 *
 * Path safety — every path from the renderer is untrusted:
 *   1. `normalizeDocPath` rejects absolute paths, `..`, backslashes and NUL;
 *   2. the resolved absolute path must be inside `root`;
 *   3. the real path of the nearest existing ancestor must be inside the real
 *      root, so a symlink inside the library can't be used to escape it;
 *   4. only `.md` files and folders may be created, and hidden segments are refused.
 *
 * Write safety:
 *   - all mutations of a path go through a per-path serial queue; queued writes
 *     are coalesced so the most recently *requested* content is what ends up on disk;
 *   - writes are temp file + fsync + rename (+ directory fsync);
 *   - for opened documents we remember the version we last read/wrote. If the
 *     file on disk no longer matches, we never overwrite it: our text goes to a
 *     `name (conflict YYYY-MM-DD HHMM).md` copy instead.
 */
export class FileSystemLibrary implements DocumentStore {
  readonly root: string;
  private realRoot: string | undefined;
  private readonly queue = new SerialQueue();
  private readonly latestWrite = new Map<string, number>();
  private writeSeq = 0;
  /** Last version of each opened document that we read, wrote or the editor acknowledged. */
  private readonly known = new Map<string, Version>();
  /** After a conflict on `key`, further saves to `key` go to the conflict copy while disk is unchanged. */
  private readonly redirects = new Map<string, { to: string; diskHash: string }>();
  private readonly watchers = new Map<string, AbortController>();
  /** Opened documents that aren't UTF-8: saving would corrupt them. */
  private readonly readOnly = new Set<string>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    root: string,
    private readonly options: LibraryOptions = {},
  ) {
    this.root = path.resolve(root);
  }

  private get link(): LinkFn {
    return this.options.link ?? ((a, b) => fs.link(a, b));
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    this.realRoot = await fs.realpath(this.root);
  }

  /** Waits for every queued write to finish. */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  dispose(): void {
    for (const ac of this.watchers.values()) ac.abort();
    this.watchers.clear();
    for (const t of this.watchTimers.values()) clearTimeout(t);
  }

  // ---------------------------------------------------------------- paths

  private key(relative: string, options: { allowRoot?: boolean } = {}): string {
    try {
      return normalizeDocPath(relative, options);
    } catch {
      throw new OutsideRootError(String(relative));
    }
  }

  /** Resolves a library-relative path to an absolute path, or throws. */
  async resolve(relative: string, options: { allowRoot?: boolean } = {}): Promise<string> {
    const normalized = this.key(relative, options);
    const absolute = path.resolve(this.root, ...normalized.split('/').filter(Boolean));
    if (!isInside(this.root, absolute)) throw new OutsideRootError(relative);

    const realRoot = this.realRoot ?? (await fs.realpath(this.root));
    let probe = absolute;
    while ((await lstatOrNull(probe)) === null) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = await fs.realpath(probe);
    if (!isInside(realRoot, realProbe)) throw new OutsideRootError(relative);
    return absolute;
  }

  private assertDocumentPath(key: string): void {
    if (isHiddenPath(key)) throw new DisallowedPathError(key, 'hidden');
    if (!isMarkdownPath(key)) throw new DisallowedPathError(key, 'not a .md file');
  }

  private assertFolderPath(key: string): void {
    if (isHiddenPath(key)) throw new DisallowedPathError(key, 'hidden');
  }

  // ---------------------------------------------------------------- DocumentStore

  async list(folder = ''): Promise<LibraryEntry[]> {
    const dir = await this.resolve(folder, { allowRoot: true });
    const parent = this.key(folder, { allowRoot: true });
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (code(error) === 'ENOENT') throw new DocumentStoreError('not-found', `No folder ${parent}`);
      throw error;
    }
    const entries: LibraryEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const rel = joinDocPath(parent, d.name);
      if (d.isDirectory()) {
        entries.push(folderEntry(rel));
      } else if (d.isFile() && isMarkdownPath(d.name)) {
        const stat = await fs.stat(path.join(dir, d.name));
        entries.push({ ...documentEntry(rel, '', stat.mtimeMs), size: stat.size });
      }
    }
    return sortEntries(entries);
  }

  async read(relative: string): Promise<string | null> {
    const key = this.key(relative);
    const file = await this.resolve(key);
    this.assertDocumentPath(key);
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (code(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async write(relative: string, content: string): Promise<void> {
    await this.save(relative, content);
  }

  /**
   * Queues a write. The per-path key is computed synchronously so that calls
   * are ordered exactly as they arrive over IPC.
   */
  save(relative: string, content: string): Promise<SaveResult> {
    let key: string;
    try {
      key = this.key(relative);
      this.assertDocumentPath(key);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.readOnly.has(key)) {
      return Promise.reject(new DisallowedPathError(key, 'not UTF-8 text; opened read-only'));
    }
    const seq = ++this.writeSeq;
    this.latestWrite.set(key, seq);
    return this.queue.run(key, async (): Promise<SaveResult> => {
      if (this.latestWrite.get(key) !== seq) return { status: 'superseded', path: key };
      return this.writeNow(key, content);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const srcKey = this.key(from);
    const dstKey = this.key(to);
    const src = await this.resolve(srcKey);
    const dst = await this.resolve(dstKey);
    if (src === dst) return;
    const stat = await lstatOrNull(src);
    if (!stat) throw new DocumentStoreError('not-found', `No such path ${from}`);
    if (isInside(src, dst)) throw new DocumentStoreError('invalid-path', 'Cannot move a folder into itself');
    await fs.mkdir(path.dirname(dst), { recursive: true });

    // Take both path locks in a stable order so concurrent renames can't deadlock.
    const [first, second] = [srcKey, dstKey].sort() as [string, string];
    await this.queue.run(first, () =>
      this.queue.run(second, async () => {
        if (stat.isDirectory()) {
          this.assertFolderPath(dstKey);
          // Claim the name exclusively, then rename onto the (empty) claimed dir.
          // If anything appeared there meanwhile, rename fails with ENOTEMPTY.
          try {
            await fs.mkdir(dst);
          } catch (error) {
            if (code(error) === 'EEXIST') throw new DocumentStoreError('exists', `${to} already exists`);
            throw error;
          }
          try {
            await fs.rename(src, dst);
          } catch (error) {
            await fs.rmdir(dst).catch(() => undefined);
            throw error;
          }
        } else {
          this.assertDocumentPath(dstKey);
          // Never replaces an existing file (link(), or O_EXCL claim + rename fallback).
          try {
            await moveNoReplace(src, dst, this.link);
          } catch (error) {
            if (code(error) === 'EEXIST') throw new DocumentStoreError('exists', `${to} already exists`);
            throw error;
          }
          const v = this.known.get(srcKey);
          this.known.delete(srcKey);
          if (v) this.known.set(dstKey, v);
        }
        await fsyncDir(path.dirname(dst));
        await fsyncDir(path.dirname(src));
      }),
    );
  }

  /** `trash` lets the main process move items to the macOS Trash instead of unlinking. */
  async delete(relative: string, trash?: (absolute: string) => Promise<void>): Promise<void> {
    const key = this.key(relative, { allowRoot: true });
    const target = await this.resolve(key, { allowRoot: true });
    if (target === this.root) throw new OutsideRootError(relative);
    this.assertFolderPath(key);
    await this.queue.run(key, async () => {
      if (!(await lstatOrNull(target))) throw new DocumentStoreError('not-found', `No such path ${relative}`);
      if (trash) await trash(target);
      else await fs.rm(target, { recursive: true });
      this.known.delete(key);
    });
  }

  async createFolder(relative: string): Promise<void> {
    const key = this.key(relative);
    this.assertFolderPath(key);
    const dir = await this.resolve(key);
    await fs.mkdir(dir, { recursive: true });
  }

  // ---------------------------------------------------------------- open documents

  /**
   * Reads a document, creating it empty if missing. Creation is exclusive
   * (link of a temp file), so a file that appears concurrently is never truncated.
   * The document becomes "tracked": later saves are checked against what we read.
   */
  async open(relative: string): Promise<OpenedDocument> {
    const key = this.key(relative);
    this.assertDocumentPath(key);
    const file = await this.resolve(key);
    const doc = await this.queue.run(key, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      let buf: Buffer;
      try {
        buf = await fs.readFile(file);
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        await this.createExclusive(file, '').catch((e: unknown) => {
          if (!(e instanceof DocumentStoreError)) throw e;
        });
        buf = await fs.readFile(file);
      }
      const stat = await fs.stat(file);
      this.known.set(key, { hash: hashOf(buf), mtimeMs: stat.mtimeMs, size: stat.size });
      this.redirects.delete(key);
      const text = decodeUtf8(buf);
      if (text === null) {
        this.readOnly.add(key);
        return { path: key, content: buf.toString('latin1'), readOnly: 'not-utf8' as const };
      }
      this.readOnly.delete(key);
      return { path: key, content: text };
    });
    this.watch(key, file);
    return doc;
  }

  /** The editor reloaded external content `token`; adopt it as the known version if disk still matches. */
  acknowledgeExternal(relative: string, token: string): Promise<boolean> {
    const key = this.key(relative);
    return this.queue.run(key, async () => {
      const file = await this.resolve(key);
      const current = await this.currentVersion(file);
      if (!current || current.hash !== token) return false;
      this.known.set(key, current);
      this.redirects.delete(key);
      return true;
    });
  }

  /** Stops watching every document except `keep`. */
  unwatchAllExcept(keep?: string): void {
    for (const [key, ac] of this.watchers) {
      if (key !== keep) {
        ac.abort();
        this.watchers.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private async currentVersion(file: string): Promise<Version | null> {
    try {
      const buf = await fs.readFile(file);
      const stat = await fs.stat(file);
      return { hash: hashOf(buf), mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      if (code(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /** Runs inside the queue for `key`. */
  private async writeNow(key: string, content: string): Promise<SaveResult> {
    const file = await this.resolve(key);
    const known = this.known.get(key);

    if (known) {
      const stat = await lstatOrNull(file);
      const unchanged = stat && stat.mtimeMs === known.mtimeMs && stat.size === known.size;
      if (stat && !unchanged) {
        const disk = await this.currentVersion(file);
        if (disk && disk.hash !== known.hash) {
          return this.writeConflictCopy(key, content, disk.hash);
        }
      }
      // stat === null: deleted externally; recreating it loses nothing.
    }

    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = await writeTemp(file, content);
    try {
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    await fsyncDir(path.dirname(file));
    if (known) {
      const stat = await fs.stat(file);
      this.known.set(key, { hash: hashOf(content), mtimeMs: stat.mtimeMs, size: stat.size });
    }
    return { status: 'saved', path: key };
  }

  private async writeConflictCopy(key: string, content: string, diskHash: string): Promise<SaveResult> {
    const redirect = this.redirects.get(key);
    if (redirect && redirect.diskHash === diskHash) {
      // Same conflict as before: keep writing to the copy we already made.
      const result = await this.queue.run(redirect.to, () => this.writeNow(redirect.to, content));
      if (result.status === 'conflict') return result;
      return { status: 'conflict', path: key, conflictPath: redirect.to };
    }
    const now = this.options.now?.() ?? new Date();
    for (let attempt = 1; attempt < 1000; attempt++) {
      const copyKey = conflictCopyPath(key, now, attempt);
      const copyFile = await this.resolve(copyKey);
      try {
        await this.createExclusive(copyFile, content);
      } catch (error) {
        if (error instanceof DocumentStoreError && error.code === 'exists') continue;
        throw error;
      }
      const stat = await fs.stat(copyFile);
      this.known.set(copyKey, { hash: hashOf(content), mtimeMs: stat.mtimeMs, size: stat.size });
      this.redirects.set(key, { to: copyKey, diskHash });
      return { status: 'conflict', path: key, conflictPath: copyKey };
    }
    throw new Error(`Could not find a free conflict-copy name for ${key}`);
  }

  /** Atomically creates `file` with `content`; throws DocumentStoreError('exists') if it exists. */
  private async createExclusive(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = await writeTemp(file, content);
    try {
      await moveNoReplace(tmp, file, this.link);
    } catch (error) {
      if (code(error) === 'EEXIST') throw new DocumentStoreError('exists', `${file} already exists`);
      throw error;
    } finally {
      await fs.rm(tmp, { force: true });
    }
    await fsyncDir(path.dirname(file));
  }

  private watch(key: string, file: string): void {
    if (this.watchers.has(key) || !this.options.onExternalChange) return;
    const ac = new AbortController();
    this.watchers.set(key, ac);
    const dir = path.dirname(file);
    const name = path.basename(file);
    // Watch the folder, not the file: editors and sync tools often replace
    // files via rename, which would orphan a file-level watcher.
    void (async () => {
      try {
        for await (const event of fs.watch(dir, { signal: ac.signal })) {
          if (event.filename === null || event.filename === name) this.scheduleCheck(key, file);
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') console.error('Margin: watcher failed', error);
      }
    })();
  }

  private scheduleCheck(key: string, file: string): void {
    clearTimeout(this.watchTimers.get(key));
    this.watchTimers.set(
      key,
      setTimeout(() => {
        this.watchTimers.delete(key);
        // Runs after any queued writes, so our own writes are never reported.
        void this.queue
          .run(key, async () => {
            const known = this.known.get(key);
            if (!known) return;
            const disk = await this.currentVersion(file);
            if (!disk || disk.hash === known.hash) return;
            const buf = await fs.readFile(file);
            if (hashOf(buf) !== disk.hash) return this.scheduleCheck(key, file); // changed again mid-read
            const content = decodeUtf8(buf);
            // Not UTF-8 any more: don't offer it to the editor. A later save will see
            // the changed hash and go to a conflict copy, leaving these bytes alone.
            if (content === null) return;
            this.options.onExternalChange?.({ path: key, content, token: disk.hash });
          })
          .catch((error: unknown) => console.error('Margin: external change check failed', error));
      }, 75),
    );
  }
}
