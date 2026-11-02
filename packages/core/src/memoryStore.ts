import { documentEntry, folderEntry, sortEntries, type LibraryEntry } from './document';
import { dirname, isWithin, normalizeDocPath } from './paths';
import { DocumentStoreError, type DocumentStore } from './store';

interface StoredDoc {
  content: string;
  modifiedAt: number;
}

export interface MemoryStoreSnapshot {
  docs: Record<string, StoredDoc>;
  folders: string[];
}

/**
 * In-memory `DocumentStore`. Used by tests, and as the basis for the web
 * (localStorage) adapter via `snapshot()` / `onChange`.
 */
export class MemoryDocumentStore implements DocumentStore {
  private docs = new Map<string, StoredDoc>();
  private folders = new Set<string>();

  constructor(
    initial?: MemoryStoreSnapshot,
    private readonly options: { now?: () => number; onChange?: (s: MemoryStoreSnapshot) => void } = {},
  ) {
    if (initial) {
      for (const [path, doc] of Object.entries(initial.docs)) this.docs.set(path, doc);
      for (const folder of initial.folders) this.folders.add(folder);
    }
  }

  snapshot(): MemoryStoreSnapshot {
    return { docs: Object.fromEntries(this.docs), folders: [...this.folders] };
  }

  async list(folder = ''): Promise<LibraryEntry[]> {
    const parent = normalizeDocPath(folder, { allowRoot: true });
    if (parent !== '' && !this.folders.has(parent)) {
      throw new DocumentStoreError('not-found', `No folder ${parent}`);
    }
    const entries: LibraryEntry[] = [];
    for (const f of this.folders) {
      if (f !== parent && dirname(f) === parent) entries.push(folderEntry(f));
    }
    for (const [path, doc] of this.docs) {
      if (dirname(path) === parent) entries.push(documentEntry(path, doc.content, doc.modifiedAt));
    }
    return sortEntries(entries);
  }

  async read(path: string): Promise<string | null> {
    return this.docs.get(normalizeDocPath(path))?.content ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    const p = normalizeDocPath(path);
    if (this.folders.has(p)) throw new DocumentStoreError('exists', `${p} is a folder`);
    this.ensureFolder(dirname(p));
    this.docs.set(p, { content, modifiedAt: this.now() });
    this.changed();
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalizeDocPath(from);
    const dst = normalizeDocPath(to);
    if (src === dst) return;
    if (this.docs.has(dst) || this.folders.has(dst)) {
      throw new DocumentStoreError('exists', `${dst} already exists`);
    }
    const doc = this.docs.get(src);
    if (doc) {
      this.ensureFolder(dirname(dst));
      this.docs.delete(src);
      this.docs.set(dst, doc);
      this.changed();
      return;
    }
    if (!this.folders.has(src)) throw new DocumentStoreError('not-found', `No such path ${src}`);
    if (isWithin(src, dst)) throw new DocumentStoreError('invalid-path', 'Cannot move a folder into itself');
    this.ensureFolder(dirname(dst));
    const move = (p: string) => dst + p.slice(src.length);
    for (const f of [...this.folders]) {
      if (isWithin(src, f)) {
        this.folders.delete(f);
        this.folders.add(move(f));
      }
    }
    for (const [p, d] of [...this.docs]) {
      if (isWithin(src, p)) {
        this.docs.delete(p);
        this.docs.set(move(p), d);
      }
    }
    this.changed();
  }

  async delete(path: string): Promise<void> {
    const p = normalizeDocPath(path);
    if (this.docs.delete(p)) {
      this.changed();
      return;
    }
    if (!this.folders.has(p)) throw new DocumentStoreError('not-found', `No such path ${p}`);
    for (const f of [...this.folders]) if (isWithin(p, f)) this.folders.delete(f);
    for (const d of [...this.docs.keys()]) if (isWithin(p, d)) this.docs.delete(d);
    this.changed();
  }

  async createFolder(path: string): Promise<void> {
    const p = normalizeDocPath(path);
    if (this.docs.has(p)) throw new DocumentStoreError('exists', `${p} is a document`);
    this.ensureFolder(p);
    this.changed();
  }

  private ensureFolder(path: string): void {
    let p = path;
    while (p !== '') {
      if (this.docs.has(p)) throw new DocumentStoreError('not-a-folder', `${p} is a document`);
      this.folders.add(p);
      p = dirname(p);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }
}
