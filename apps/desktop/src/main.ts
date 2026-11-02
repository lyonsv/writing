import path from 'node:path';

import { IPC_CHANNELS } from '@margin/core';
import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';

import { FileSystemLibrary } from './library';
import { APP_ORIGIN, handleAppScheme, registerAppScheme } from './protocol';

/**
 * Environment overrides (used by tests and the dev script):
 *   MARGIN_DEV_SERVER_URL  load this URL (the Expo web dev server) instead of app://
 *   MARGIN_LIBRARY_DIR     library folder (default ~/Documents/Margin)
 *   MARGIN_USER_DATA_DIR   Electron userData folder (isolates test runs)
 *   MARGIN_WEB_DIR         Expo web export folder (default: packaged resources or ../app/dist)
 *   MARGIN_SHOW_INACTIVE   show the window without taking OS focus (automated tests)
 */
const DEV_SERVER_URL = process.env.MARGIN_DEV_SERVER_URL;

if (process.env.MARGIN_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MARGIN_USER_DATA_DIR));
}

registerAppScheme();

const libraryDir = path.resolve(process.env.MARGIN_LIBRARY_DIR ?? path.join(app.getPath('documents'), 'Margin'));
const library = new FileSystemLibrary(libraryDir);

function webRoot(): string {
  if (process.env.MARGIN_WEB_DIR) return path.resolve(process.env.MARGIN_WEB_DIR);
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  // apps/desktop/dist/main.js -> apps/app/dist
  return path.resolve(__dirname, '../../app/dist');
}

function startUrl(): string {
  return DEV_SERVER_URL ?? `${APP_ORIGIN}/`;
}

function isTrustedOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    // Node's URL reports origin "null" for custom schemes, so compare parts.
    if (`${u.protocol}//${u.host}` === APP_ORIGIN) return true;
    return DEV_SERVER_URL !== undefined && u.origin === new URL(DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
}

/** IPC handlers only answer our own top-level page. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null || !isTrustedOrigin(frame.url)) {
    throw new Error('Untrusted IPC sender');
  }
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    for (const arg of args) {
      if (arg !== undefined && typeof arg !== 'string') throw new TypeError('Expected string arguments');
    }
    return fn(...(args as A));
  });
}

function registerIpc(): void {
  handle(IPC_CHANNELS.list, (folder?: string) => library.list(folder));
  handle(IPC_CHANNELS.read, (p: string) => library.read(p));
  handle(IPC_CHANNELS.write, (p: string, content: string) => library.write(p, content));
  handle(IPC_CHANNELS.rename, (from: string, to: string) => library.rename(from, to));
  handle(IPC_CHANNELS.delete, (p: string) => library.delete(p, (abs) => shell.trashItem(abs)));
  handle(IPC_CHANNELS.createFolder, (p: string) => library.createFolder(p));
  handle(IPC_CHANNELS.libraryRoot, async () => library.root);
  handle(IPC_CHANNELS.toggleFullScreen, async () => toggleFullScreen());
}

function toggleFullScreen(win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]): void {
  if (win) win.setFullScreen(!win.isFullScreen());
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: 'toggle-fullscreen',
          label: 'Enter Full Screen',
          accelerator: 'Control+Command+F',
          click: (_item, win) => toggleFullScreen(win instanceof BrowserWindow ? win : undefined),
        },
        ...(app.isPackaged
          ? []
          : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function updateFullScreenLabel(fullScreen: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-fullscreen');
  if (item) item.label = fullScreen ? 'Exit Full Screen' : 'Enter Full Screen';
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'Margin',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    fullscreenable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#fbfbfa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => (process.env.MARGIN_SHOW_INACTIVE ? win.showInactive() : win.show()));
  win.on('enter-full-screen', () => updateFullScreenLabel(true));
  win.on('leave-full-screen', () => updateFullScreenLabel(false));

  // No new windows; http(s) links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedOrigin(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  void win.loadURL(startUrl());
  return win;
}

app.whenReady().then(async () => {
  await library.init();
  if (!DEV_SERVER_URL) handleAppScheme(webRoot());
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
