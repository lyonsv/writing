import {
  DESKTOP_BRIDGE_KEY,
  IPC_CHANNELS,
  type DesktopBridge,
  type ExternalChange,
  type FlushResult,
  type Settings,
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
  libraryRoot: () => invoke(IPC_CHANNELS.libraryRoot),
  toggleFullScreen: () => invoke(IPC_CHANNELS.toggleFullScreen),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
