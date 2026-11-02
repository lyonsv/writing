import type { LibraryEntry } from './document';

/**
 * Contract between the Electron preload script and the shared app.
 * The preload exposes an object of this shape on `window[DESKTOP_BRIDGE_KEY]`
 * via `contextBridge`; each method is a thin `ipcRenderer` wrapper.
 * See docs/decisions/0006-save-pipeline.md for the save semantics.
 */
export const DESKTOP_BRIDGE_KEY = 'marginDesktop';

export const IPC_CHANNELS = {
  list: 'margin:store:list',
  read: 'margin:store:read',
  write: 'margin:store:write',
  rename: 'margin:store:rename',
  delete: 'margin:store:delete',
  createFolder: 'margin:store:create-folder',
  open: 'margin:doc:open',
  save: 'margin:doc:save',
  acknowledgeExternal: 'margin:doc:ack-external',
  externalChange: 'margin:doc:external-change',
  flushRequest: 'margin:flush-request',
  flushDone: 'margin:flush-done',
  libraryRoot: 'margin:library-root',
  toggleFullScreen: 'margin:window:toggle-fullscreen',
} as const;

/** Window event the editor listens for: flush pending text synchronously via onChange. */
export const FLUSH_EVENT = 'margin:flush';

export type SaveResult =
  | { status: 'saved'; path: string }
  /** A newer save for the same path was queued; it will be written instead. */
  | { status: 'superseded'; path: string }
  /**
   * The file changed on disk since we last read or wrote it. The on-disk file
   * was left alone and our text was written to `conflictPath` instead.
   */
  | { status: 'conflict'; path: string; conflictPath: string };

export interface OpenedDocument {
  path: string;
  content: string;
}

/** Sent when the open document changes on disk without us writing it. */
export interface ExternalChange {
  path: string;
  content: string;
  /** Opaque version token; pass to `acknowledgeExternal` after reloading. */
  token: string;
}

export interface DesktopStoreBridge {
  list(folder?: string): Promise<LibraryEntry[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  createFolder(path: string): Promise<void>;
}

export interface DesktopDocumentsBridge {
  /** Reads (creating it empty, exclusively, if missing) and starts watching the document. */
  open(path: string): Promise<OpenedDocument>;
  save(path: string, content: string): Promise<SaveResult>;
  /** Confirms the editor reloaded external content `token`; returns false if disk moved on again. */
  acknowledgeExternal(path: string, token: string): Promise<boolean>;
  onExternalChange(listener: (change: ExternalChange) => void): () => void;
}

export interface DesktopBridge {
  platform: string;
  store: DesktopStoreBridge;
  documents: DesktopDocumentsBridge;
  /**
   * Registers a handler the main process runs before a window closes or the app
   * quits; the close/quit waits for every handler's promise.
   */
  onFlushRequest(handler: () => Promise<void>): () => void;
  /** Absolute path of the library folder on disk (display only). */
  libraryRoot(): Promise<string>;
  toggleFullScreen(): Promise<void>;
}
