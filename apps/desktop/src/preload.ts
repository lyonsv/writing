import { DESKTOP_BRIDGE_KEY, IPC_CHANNELS, type DesktopBridge } from '@margin/core';
import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preload: only `electron` may be required at runtime; @margin/core is
// inlined by esbuild (and only constants are used from it here).
const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

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
  libraryRoot: () => invoke(IPC_CHANNELS.libraryRoot),
  toggleFullScreen: () => invoke(IPC_CHANNELS.toggleFullScreen),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
