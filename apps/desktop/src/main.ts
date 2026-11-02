import path from 'node:path';

import { IPC_CHANNELS, type ExternalChange, type FocusScopeSetting, type Settings } from '@margin/core';
import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';

import { FileSystemLibrary } from './library';
import { SettingsFile } from './settings';
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
/** How long to wait for a renderer to flush before closing anyway (it may be hung). */
const FLUSH_TIMEOUT_MS = 20_000;

if (process.env.MARGIN_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MARGIN_USER_DATA_DIR));
}

registerAppScheme();

const libraryDir = path.resolve(process.env.MARGIN_LIBRARY_DIR ?? path.join(app.getPath('documents'), 'Margin'));
const library = new FileSystemLibrary(libraryDir, { onExternalChange: broadcastExternalChange });

let settings: SettingsFile;

function broadcastExternalChange(change: ExternalChange): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.externalChange, change);
  }
}

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
function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
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

// ------------------------------------------------------------------ flush handshake

let flushSeq = 0;
const flushWaiters = new Map<number, () => void>();

/**
 * Asks the window's renderer to push any unsaved editor text through `save`
 * and waits for it to confirm, then waits for the write queue to drain.
 */
function flushWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isCrashed()) return library.idle();
  const id = ++flushSeq;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters.delete(id);
      console.warn(`Margin: renderer did not confirm flush within ${FLUSH_TIMEOUT_MS}ms`);
      resolve();
    }, FLUSH_TIMEOUT_MS);
    flushWaiters.set(id, () => {
      clearTimeout(timer);
      flushWaiters.delete(id);
      resolve();
    });
    win.webContents.send(IPC_CHANNELS.flushRequest, id);
  }).then(() => library.idle());
}

let quitReady = false;
let quitting = false;

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void Promise.all(BrowserWindow.getAllWindows().map(flushWindow))
    .then(() => Promise.all([library.idle(), settings?.idle()]))
    .catch((error: unknown) => console.error('Margin: flush before quit failed', error))
    .finally(() => {
      quitReady = true;
      library.dispose();
      app.quit();
    });
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => app.quit());
}

function registerIpc(): void {
  handle(IPC_CHANNELS.list, (folder?: string) => library.list(folder));
  handle(IPC_CHANNELS.read, (p: string) => library.read(p));
  handle(IPC_CHANNELS.write, (p: string, content: string) => library.write(p, content));
  handle(IPC_CHANNELS.rename, (from: string, to: string) => library.rename(from, to));
  handle(IPC_CHANNELS.delete, (p: string) => library.delete(p, (abs) => shell.trashItem(abs)));
  handle(IPC_CHANNELS.createFolder, (p: string) => library.createFolder(p));
  handle(IPC_CHANNELS.open, async (p: string) => {
    const doc = await library.open(p);
    library.unwatchAllExcept(doc.path); // single-document UI for now
    return doc;
  });
  handle(IPC_CHANNELS.save, (p: string, content: string) => library.save(p, content));
  handle(IPC_CHANNELS.acknowledgeExternal, (p: string, token: string) => library.acknowledgeExternal(p, token));
  handle(IPC_CHANNELS.libraryRoot, async () => library.root);
  handle(IPC_CHANNELS.settingsLoad, async () => settings.get());
  // Not via handle(): the patch is an object, validated by parseSettingsPatch inside update().
  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, patch: unknown) => {
    assertTrustedSender(event);
    return settings.update(patch);
  });
  handle(IPC_CHANNELS.toggleFullScreen, async () => toggleFullScreen());

  ipcMain.on(IPC_CHANNELS.flushDone, (event, id: unknown) => {
    try {
      assertTrustedSender(event);
    } catch {
      return;
    }
    if (typeof id === 'number') flushWaiters.get(id)?.();
  });
}

// ------------------------------------------------------------------ window

function toggleFullScreen(win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]): void {
  if (win) win.setFullScreen(!win.isFullScreen());
}

function updateSettings(patch: Partial<Settings>): void {
  void settings.update(patch);
}

const scopeItem = (scope: FocusScopeSetting, label: string, accelerator: string): MenuItemConstructorOptions => ({
  id: `focus-scope-${scope}`,
  label,
  type: 'radio',
  accelerator,
  checked: settings.get().focusScope === scope,
  click: () => updateSettings({ focusScope: scope }),
});

/** Reflects settings in the menu and window chrome. */
function applySettings(s: Settings): void {
  const menu = Menu.getApplicationMenu();
  const set = (id: string, checked: boolean) => {
    const item = menu?.getMenuItemById(id);
    if (item) item.checked = checked;
  };
  set('focus-mode', s.focusMode);
  set('typewriter', s.typewriter);
  // Radio items: only ever set the selected one; Electron unchecks the rest of the group
  // (setting a radio item to false makes Electron check a sibling instead).
  set(`focus-scope-${s.focusScope}`, true);
  for (const win of BrowserWindow.getAllWindows()) {
    // Focus mode: cursor-only, also when windowed: hide the traffic lights.
    if (process.platform === 'darwin' && !win.isDestroyed()) win.setWindowButtonVisibility(!s.focusMode);
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.settingsChanged, s);
  }
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
          id: 'focus-mode',
          label: 'Focus Mode',
          type: 'checkbox',
          accelerator: 'CommandOrControl+Shift+F',
          checked: settings.get().focusMode,
          click: () => updateSettings({ focusMode: !settings.get().focusMode }),
        },
        {
          label: 'Focus On',
          submenu: [
            scopeItem('sentence', 'Sentence', 'Alt+CommandOrControl+1'),
            scopeItem('paragraph', 'Paragraph', 'Alt+CommandOrControl+2'),
            scopeItem('off', 'Nothing (Hide Chrome Only)', 'Alt+CommandOrControl+0'),
          ],
        },
        {
          id: 'typewriter',
          label: 'Typewriter Scrolling',
          type: 'checkbox',
          accelerator: 'Alt+CommandOrControl+T',
          checked: settings.get().typewriter,
          click: () => updateSettings({ typewriter: !settings.get().typewriter }),
        },
        { type: 'separator' },
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateFullScreenLabel(fullScreen: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-fullscreen');
  if (item) item.label = fullScreen ? 'Exit Full Screen' : 'Enter Full Screen';
}

function blockUntrustedNavigation(event: { preventDefault(): void }, url: string): void {
  if (isTrustedOrigin(url)) return;
  event.preventDefault();
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
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
      webviewTag: false,
      spellcheck: true,
    },
  });

  if (process.platform === 'darwin') win.setWindowButtonVisibility(!settings.get().focusMode);
  win.once('ready-to-show', () => (process.env.MARGIN_SHOW_INACTIVE ? win.showInactive() : win.show()));
  win.on('enter-full-screen', () => updateFullScreenLabel(true));
  win.on('leave-full-screen', () => updateFullScreenLabel(false));

  // Closing the window flushes unsaved text first (quit has its own flush).
  let closeReady = false;
  let closing = false;
  win.on('close', (event) => {
    if (closeReady || quitReady) return;
    event.preventDefault();
    if (closing || quitting) return;
    closing = true;
    void flushWindow(win).finally(() => {
      closeReady = true;
      if (!win.isDestroyed()) win.close();
    });
  });

  // No new windows; http(s) links open in the default browser.
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => blockUntrustedNavigation(event, url));
  contents.on('will-redirect', (event, url) => blockUntrustedNavigation(event, url));
  contents.on('will-frame-navigate', (event) => blockUntrustedNavigation(event, event.url));
  contents.on('will-attach-webview', (event) => event.preventDefault());

  void win.loadURL(startUrl());
  return win;
}

app.whenReady().then(async () => {
  await library.init();
  settings = new SettingsFile(path.join(app.getPath('userData'), 'settings.json'));
  await settings.load();
  settings.onChange(applySettings);
  // No camera, mic, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
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
