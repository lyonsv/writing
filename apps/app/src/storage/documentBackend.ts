import type {
  DesktopBridge,
  DocumentStore,
  ExternalChange,
  FlushResult,
  OpenedDocument,
  SaveResult,
} from '@margin/core';

/**
 * What the editor screen needs from a platform: open a document, save it,
 * and (desktop only) hear about external changes and close/quit flushes.
 */
export interface DocumentBackend {
  open(path: string): Promise<OpenedDocument>;
  save(path: string, content: string): Promise<SaveResult>;
  acknowledgeExternal?(path: string, token: string): Promise<boolean>;
  onExternalChange?(listener: (change: ExternalChange) => void): () => void;
  onFlushRequest?(handler: () => Promise<FlushResult>): () => void;
}

/** Electron: the main process owns files, the write queue and conflict detection. */
export function desktopBackend(bridge: DesktopBridge): DocumentBackend {
  return {
    open: (path) => bridge.documents.open(path),
    save: (path, content) => bridge.documents.save(path, content),
    acknowledgeExternal: (path, token) => bridge.documents.acknowledgeExternal(path, token),
    onExternalChange: (listener) => bridge.documents.onExternalChange(listener),
    onFlushRequest: (handler) => bridge.onFlushRequest(handler),
  };
}

/** Browser / native stub: a plain DocumentStore, single writer, no external changes. */
export function storeBackend(store: DocumentStore): DocumentBackend {
  return {
    async open(path) {
      let content = await store.read(path);
      if (content === null) {
        content = '';
        await store.write(path, content);
      }
      return { path, content };
    },
    async save(path, content) {
      await store.write(path, content);
      return { status: 'saved', path };
    },
  };
}
