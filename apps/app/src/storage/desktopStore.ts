import type { DesktopBridge, DocumentStore } from '@margin/core';

/** Electron adapter: every call goes over IPC to the main process, which owns the files. */
export function createDesktopStore(bridge: DesktopBridge): DocumentStore {
  const s = bridge.store;
  return {
    list: (folder) => s.list(folder),
    read: (path) => s.read(path),
    write: (path, content) => s.write(path, content),
    rename: (from, to) => s.rename(from, to),
    delete: (path) => s.delete(path),
    createFolder: (path) => s.createFolder(path),
  };
}
