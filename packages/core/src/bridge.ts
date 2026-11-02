import type { AccountBackend } from './account';
import type { SyncStatus } from './sync';
import type { LibraryEntry, LibraryListing } from './document';
import type { Settings } from './settings';

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
  libraryTree: 'margin:library:tree',
  libraryCreateDocument: 'margin:library:create-document',
  libraryReveal: 'margin:library:reveal',
  libraryContextMenu: 'margin:library:context-menu',
  libraryChanged: 'margin:library:changed',
  command: 'margin:command',
  settingsLoad: 'margin:settings:load',
  settingsUpdate: 'margin:settings:update',
  settingsChanged: 'margin:settings:changed',
  libraryRoot: 'margin:library-root',
  toggleFullScreen: 'margin:window:toggle-fullscreen',
  accountStatus: 'margin:account:status',
  accountSignIn: 'margin:account:sign-in',
  accountSignOut: 'margin:account:sign-out',
  accountDevices: 'margin:account:devices',
  accountRevoke: 'margin:account:revoke',
  accountChanged: 'margin:account:changed',
  syncStatus: 'margin:sync:status',
  syncNow: 'margin:sync:now',
  syncChanged: 'margin:sync:changed',
} as const;

/** Window event the editor listens for: flush pending text synchronously via onChange. */
export const FLUSH_EVENT = 'margin:flush';
/** Window event the editor listens for: take keyboard focus (e.g. after quick open closes). */
export const FOCUS_EDITOR_EVENT = 'margin:focus-editor';

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
  /**
   * Set when the file must not be edited. `not-utf8`: the bytes aren't valid
   * UTF-8 (e.g. Latin-1/UTF-16), so `content` is a lossy preview and saving
   * would corrupt the file; the main process refuses saves to it.
   */
  readOnly?: 'not-utf8';
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

/** What a renderer reports after a flush request. */
export interface FlushResult {
  /** True if everything the user typed is on disk. */
  clean: boolean;
  /** When not clean: the document path and the text that couldn't be saved. */
  path?: string;
  unsavedText?: string;
}

/** Commands the desktop menu sends to the renderer. */
export type AppCommand = 'new-document' | 'new-folder' | 'quick-open' | 'account';
export const APP_COMMANDS: readonly AppCommand[] = ['new-document', 'new-folder', 'quick-open', 'account'];

export type ContextMenuItem = { id: string; label: string; enabled?: boolean } | { type: 'separator' };

export interface DesktopLibraryBridge {
  /** Flat recursive listing (folders + .md documents), flagged if it was cut off. */
  listTree(): Promise<LibraryListing>;
  /** Creates an empty document; rejects if anything exists at `path`. */
  createDocument(path: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  /** Rename or move; never replaces an existing destination. */
  rename(from: string, to: string): Promise<void>;
  /** Moves to the macOS Trash (never a hard delete). */
  trash(path: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  /** Shows a native context menu; resolves with the chosen item id, or null if dismissed. */
  showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** Fires (debounced) when anything in the library folder changes on disk. */
  onChange(listener: () => void): () => void;
}

export interface DesktopSettingsBridge {
  load(): Promise<Settings>;
  /** Unknown keys / invalid values are ignored by the main process. */
  update(patch: Partial<Settings>): Promise<Settings>;
  /** Fires after any change, including ones made from the application menu. */
  onChange(listener: (settings: Settings) => void): () => void;
}

export interface DesktopBridge {
  platform: string;
  store: DesktopStoreBridge;
  documents: DesktopDocumentsBridge;
  library: DesktopLibraryBridge;
  settings: DesktopSettingsBridge;
  /**
   * Sign-in and device management. Main holds the token (safeStorage) and makes
   * every authenticated request; the renderer only ever sees `AccountStatus`.
   */
  account: Omit<AccountBackend, 'available'>;
  /** Library sync status (ADR 0013); runs in main. */
  sync: {
    status(): Promise<SyncStatus>;
    syncNow(): Promise<SyncStatus>;
    onChange(listener: (status: SyncStatus) => void): () => void;
  };
  onCommand(listener: (command: AppCommand) => void): () => void;
  /**
   * Registers a handler the main process runs before a window closes or the app
   * quits; the close/quit waits for every handler's promise.
   */
  onFlushRequest(handler: () => Promise<FlushResult>): () => void;
  /** Absolute path of the library folder on disk (display only). */
  libraryRoot(): Promise<string>;
  toggleFullScreen(): Promise<void>;
}
