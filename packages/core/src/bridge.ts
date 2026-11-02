import type { LibraryEntry } from './document';

/**
 * Contract between the Electron preload script and the shared app.
 * The preload exposes an object of this shape on `window[DESKTOP_BRIDGE_KEY]`
 * via `contextBridge`; each method is a thin `ipcRenderer.invoke` wrapper.
 */
export const DESKTOP_BRIDGE_KEY = 'marginDesktop';

export const IPC_CHANNELS = {
  list: 'margin:store:list',
  read: 'margin:store:read',
  write: 'margin:store:write',
  rename: 'margin:store:rename',
  delete: 'margin:store:delete',
  createFolder: 'margin:store:create-folder',
  libraryRoot: 'margin:library-root',
  toggleFullScreen: 'margin:window:toggle-fullscreen',
} as const;

export interface DesktopStoreBridge {
  list(folder?: string): Promise<LibraryEntry[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  createFolder(path: string): Promise<void>;
}

export interface DesktopBridge {
  platform: string;
  store: DesktopStoreBridge;
  /** Absolute path of the library folder on disk (display only). */
  libraryRoot(): Promise<string>;
  toggleFullScreen(): Promise<void>;
}
