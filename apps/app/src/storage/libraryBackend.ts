import {
  DocumentStoreError,
  listAll,
  type AppCommand,
  type ContextMenuItem,
  type DesktopBridge,
  type DocumentStore,
  type LibraryEntry,
} from '@margin/core';

/** Library operations the UI needs; implemented per platform. */
export interface LibraryBackend {
  listTree(): Promise<LibraryEntry[]>;
  createDocument(path: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Desktop: macOS Trash. Browser/native stub: removes from the store. */
  trash(path: string): Promise<void>;
  revealInFinder?(path: string): Promise<void>;
  /** Native context menu (desktop); otherwise the UI shows its own. */
  showContextMenu?(items: ContextMenuItem[]): Promise<string | null>;
  onChange?(listener: () => void): () => void;
  onCommand?(listener: (command: AppCommand) => void): () => void;
}

export function desktopLibraryBackend(bridge: DesktopBridge): LibraryBackend {
  const l = bridge.library;
  return {
    listTree: () => l.listTree(),
    createDocument: (p) => l.createDocument(p),
    createFolder: (p) => l.createFolder(p),
    rename: (a, b) => l.rename(a, b),
    trash: (p) => l.trash(p),
    revealInFinder: (p) => l.revealInFinder(p),
    showContextMenu: (items) => l.showContextMenu(items),
    onChange: (cb) => l.onChange(cb),
    onCommand: (cb) => bridge.onCommand(cb),
  };
}

/** Any DocumentStore (localStorage, memory). Single writer, so no change events. */
export function storeLibraryBackend(store: DocumentStore): LibraryBackend {
  return {
    listTree: () => listAll(store),
    async createDocument(p) {
      if ((await store.read(p)) !== null) throw new DocumentStoreError('exists', `${p} already exists`);
      await store.write(p, '');
    },
    createFolder: (p) => store.createFolder(p),
    rename: (a, b) => store.rename(a, b),
    trash: (p) => store.delete(p),
  };
}
