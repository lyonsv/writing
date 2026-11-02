import {
  APP_COMMANDS,
  DESKTOP_BRIDGE_KEY,
  IPC_CHANNELS,
  type AccountStatus,
  type AppCommand,
  type DesktopBridge,
  type ExternalChange,
  type FlushResult,
  type Settings,
  type SyncStatus,
} from '@margin/core';
import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preload: only `electron` may be required at runtime; @margin/core is
// inlined by esbuild (only constants are used from it here).
const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

// Flush handshake: main asks before closing/quitting; we run every registered
// handler (the app pushes unsaved text and awaits the save), then report
// whether everything reached disk.
const flushHandlers = new Set<() => Promise<FlushResult>>();
ipcRenderer.on(IPC_CHANNELS.flushRequest, (_event, id: number) => {
  void Promise.allSettled([...flushHandlers].map((h) => h())).then((settled) => {
    let result: FlushResult = { clean: true };
    for (const r of settled) {
      if (r.status === 'rejected') result = { clean: false };
      else if (!r.value.clean) result = r.value;
      if (!result.clean) break;
    }
    ipcRenderer.send(IPC_CHANNELS.flushDone, id, result);
  });
});

const bridge: DesktopBridge = {
  platform: process.platform,
  store: {
    list: (folder) => invoke(IPC_CHANNELS.list, folder),
    read: (path) => invoke(IPC_CHANNELS.read, path),
    write: (path, content) => invoke(IPC_CHANNELS.write, path, content),
    rename: (from, to) => invoke(IPC_CHANNELS.rename, from, to),
    delete: (path) => invoke(IPC_CHANNELS.delete, path),
    createFolder: (path) => invoke(IPC_CHANNELS.createFolder, path),
  },
  documents: {
    open: (path) => invoke(IPC_CHANNELS.open, path),
    save: (path, content) => invoke(IPC_CHANNELS.save, path, content),
    acknowledgeExternal: (path, token) => invoke(IPC_CHANNELS.acknowledgeExternal, path, token),
    onExternalChange: (listener) => {
      const wrapped = (_event: unknown, change: ExternalChange) => listener(change);
      ipcRenderer.on(IPC_CHANNELS.externalChange, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.externalChange, wrapped);
      };
    },
  },
  library: {
    listTree: () => invoke(IPC_CHANNELS.libraryTree),
    createDocument: (path) => invoke(IPC_CHANNELS.libraryCreateDocument, path),
    createFolder: (path) => invoke(IPC_CHANNELS.createFolder, path),
    rename: (from, to) => invoke(IPC_CHANNELS.rename, from, to),
    trash: (path) => invoke(IPC_CHANNELS.delete, path),
    revealInFinder: (path) => invoke(IPC_CHANNELS.libraryReveal, path),
    showContextMenu: (items) => invoke(IPC_CHANNELS.libraryContextMenu, items),
    onChange: (listener) => {
      const wrapped = () => listener();
      ipcRenderer.on(IPC_CHANNELS.libraryChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.libraryChanged, wrapped);
      };
    },
  },
  onCommand: (listener) => {
    const wrapped = (_event: unknown, command: AppCommand) => {
      if (APP_COMMANDS.includes(command)) listener(command);
    };
    ipcRenderer.on(IPC_CHANNELS.command, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.command, wrapped);
    };
  },
  settings: {
    load: () => invoke(IPC_CHANNELS.settingsLoad),
    update: (patch) => invoke(IPC_CHANNELS.settingsUpdate, patch),
    onChange: (listener) => {
      const wrapped = (_event: unknown, s: Settings) => listener(s);
      ipcRenderer.on(IPC_CHANNELS.settingsChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, wrapped);
      };
    },
  },
  onFlushRequest: (handler) => {
    flushHandlers.add(handler);
    return () => {
      flushHandlers.delete(handler);
    };
  },
  // The token lives in main only; these calls return statuses and device lists, never the token.
  account: {
    status: () => invoke(IPC_CHANNELS.accountStatus),
    signIn: () => invoke(IPC_CHANNELS.accountSignIn),
    signOut: () => invoke(IPC_CHANNELS.accountSignOut),
    listDevices: () => invoke(IPC_CHANNELS.accountDevices),
    revokeDevice: (id) => invoke(IPC_CHANNELS.accountRevoke, id),
    onChange: (listener) => {
      const wrapped = (_event: unknown, s: AccountStatus) => listener(s);
      ipcRenderer.on(IPC_CHANNELS.accountChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.accountChanged, wrapped);
      };
    },
  },
  sync: {
    status: () => invoke(IPC_CHANNELS.syncStatus),
    syncNow: () => invoke(IPC_CHANNELS.syncNow),
    onChange: (listener) => {
      const wrapped = (_event: unknown, s: SyncStatus) => listener(s);
      ipcRenderer.on(IPC_CHANNELS.syncChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.syncChanged, wrapped);
      };
    },
  },
  libraryRoot: () => invoke(IPC_CHANNELS.libraryRoot),
  toggleFullScreen: () => invoke(IPC_CHANNELS.toggleFullScreen),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
