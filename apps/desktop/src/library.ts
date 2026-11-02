import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DocumentStoreError,
  documentEntry,
  folderEntry,
  isMarkdownPath,
  joinDocPath,
  normalizeDocPath,
  sortEntries,
  type DocumentStore,
  type LibraryEntry,
} from '@margin/core';

/** Thrown when a requested path would resolve outside the library root. */
export class OutsideRootError extends Error {
  constructor(requested: string) {
    super(`Path is outside the library root: ${JSON.stringify(requested)}`);
    this.name = 'OutsideRootError';
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `DocumentStore` backed by real `.md` files under `root`. Runs in the
 * Electron main process. Every path from the renderer is untrusted:
 *   1. `normalizeDocPath` rejects absolute paths, `..`, backslashes and NUL;
 *   2. the resolved absolute path must be inside `root`;
 *   3. the real path of the nearest existing ancestor must also be inside the
 *      real root, so a symlink inside the library can't be used to escape it.
 */
export class FileSystemLibrary implements DocumentStore {
  private realRoot: string | undefined;

  constructor(readonly root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    this.realRoot = await fs.realpath(this.root);
  }

  /** Resolves a library-relative path to an absolute path, or throws. */
  async resolve(relative: string, options: { allowRoot?: boolean } = {}): Promise<string> {
    let normalized: string;
    try {
      normalized = normalizeDocPath(relative, options);
    } catch {
      throw new OutsideRootError(String(relative));
    }
    const absolute = path.resolve(this.root, ...normalized.split('/').filter(Boolean));
    if (!isInside(this.root, absolute)) throw new OutsideRootError(relative);

    const realRoot = this.realRoot ?? (await fs.realpath(this.root));
    let probe = absolute;
    while (!(await exists(probe))) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = await fs.realpath(probe);
    if (!isInside(realRoot, realProbe)) throw new OutsideRootError(relative);
    return absolute;
  }

  async list(folder = ''): Promise<LibraryEntry[]> {
    const dir = await this.resolve(folder, { allowRoot: true });
    const parent = normalizeDocPath(folder, { allowRoot: true });
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DocumentStoreError('not-found', `No folder ${parent}`);
      }
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
        const entry = documentEntry(rel, '', stat.mtimeMs);
        entries.push({ ...entry, size: stat.size });
      }
    }
    return sortEntries(entries);
  }

  async read(relative: string): Promise<string | null> {
    const file = await this.resolve(relative);
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Atomic write: temp file in the same folder, then rename over the target. */
  async write(relative: string, content: string): Promise<void> {
    const file = await this.resolve(relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    const dst = await this.resolve(to);
    if (src === dst) return;
    if (!(await exists(src))) throw new DocumentStoreError('not-found', `No such path ${from}`);
    if (await exists(dst)) throw new DocumentStoreError('exists', `${to} already exists`);
    if (isInside(src, dst)) throw new DocumentStoreError('invalid-path', 'Cannot move a folder into itself');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  /**
   * Deletes a document or folder. `trash` is injected so the main process can
   * move items to the macOS Trash instead of unlinking them.
   */
  async delete(relative: string, trash?: (absolute: string) => Promise<void>): Promise<void> {
    const target = await this.resolve(relative);
    if (target === this.root) throw new OutsideRootError(relative);
    if (!(await exists(target))) throw new DocumentStoreError('not-found', `No such path ${relative}`);
    if (trash) await trash(target);
    else await fs.rm(target, { recursive: true });
  }

  async createFolder(relative: string): Promise<void> {
    const dir = await this.resolve(relative);
    await fs.mkdir(dir, { recursive: true });
  }
}
