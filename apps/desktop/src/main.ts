import path from 'node:path';

import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';

import {
  IPC_CHANNELS,
  defaultServerUrl,
  basename,
  displayName,
  type AppCommand,
  type ContextMenuItem,
  type ExternalChange,
  type FlushResult,
  type FocusScopeSetting,
  type Settings,
} from '@margin/core';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';

import { watch as watchTree, type FSWatcher } from 'chokidar';

import { AccountError, AccountManager } from './account';
import { SyncService } from './sync';
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
 *   MARGIN_TEST_NO_HARDLINKS  simulate a filesystem without hard links (tests)
 *   MARGIN_TEST_LIST_LIMIT    cap the library listing at this many entries (tests)
 *   MARGIN_SERVER_URL      Margin server origin for sign-in (else settings.serverUrl, else https://margin-sync.vercel.app
 *                          when packaged, http://127.0.0.1:3000 in development)
 *   MARGIN_SYNC_INTERVAL_MS  sync timer (default 30000; tests)
 */
const DEV_SERVER_URL = process.env.MARGIN_DEV_SERVER_URL;
/**
 * How long to wait for a renderer to confirm its flush. A healthy renderer
 * answers in milliseconds (a 20 MB document in well under a second); after
 * this it is treated as hung and its window is destroyed, since its text is
 * unreachable anyway and a hung page would otherwise block quit indefinitely.
 */
const FLUSH_TIMEOUT_MS = 5_000;

if (process.env.MARGIN_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MARGIN_USER_DATA_DIR));
}

registerAppScheme();

let library!: FileSystemLibrary;
let treeWatcher: FSWatcher | undefined;
let settings: SettingsFile;
let account: AccountManager;
let sync: SyncService;

/**
 * Before each sync run: ask every window to push unsaved editor text through the
 * save pipeline (ADR 0006), so uploads include what was typed. Unlike quit, a
 * slow renderer is never destroyed: we just skip this run and try again later.
 */
async function flushForSync(): Promise<boolean> {
  const outcomes = await Promise.all(
    BrowserWindow.getAllWindows().map((w) => flushWindow(w, { timeoutMs: 3_000, destroyOnTimeout: false })),
  );
  return outcomes.every((o) => o.clean && !('unresponsive' in o));
}

/** Margin › Reset Sync State for This Folder… (docs/sync-recovery.md). Never deletes local text. */
async function confirmResetSync(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    type: 'warning' as const,
    message: 'Reset sync state for this folder?',
    detail:
      'Margin forgets what this folder last agreed with the server and compares everything again. ' +
      'No document is deleted. Documents only on this Mac are uploaded, documents only on the server are downloaded, ' +
      'and where the two differ your version is kept as a “(conflict …)” copy next to the server’s.',
    buttons: ['Cancel', 'Reset and Sync'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response === 1) await sync.resetBase();
}

function createSync(): SyncService {
  return new SyncService({
    library: () => library,
    account,
    stateDir: path.join(app.getPath('userData'), 'sync'),
    trash: (abs) => shell.trashItem(abs),
    beforeSync: flushForSync,
    intervalMs: Number(process.env.MARGIN_SYNC_INTERVAL_MS) || 30_000,
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.syncChanged, status);
      }
    },
  });
}

// Packaged app: the production server. Development and tests (unpackaged): pnpm dev:server and the dev OAuth callback.
export const DEFAULT_SERVER_URL = defaultServerUrl(app.isPackaged);
const serverUrl = () => process.env.MARGIN_SERVER_URL || settings.get().serverUrl || DEFAULT_SERVER_URL;

function createAccount(): AccountManager {
  return new AccountManager({
    file: path.join(app.getPath('userData'), 'account', 'session.bin'),
    serverUrl,
    openExternal: (url) => shell.openExternal(url),
    secretBox: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (sealed) => safeStorage.decryptString(sealed),
    },
    deviceName: () => `${os.hostname().replace(/\.local$/, '')} (Margin for Mac)`,
    onChange: (status) => {
      updateAccountMenu();
      sync?.accountChanged();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.accountChanged, status);
      }
    },
  });
}

function updateAccountMenu(): void {
  const menu = Menu.getApplicationMenu();
  const state = account?.status().state;
  const signIn = menu?.getMenuItemById('sign-in');
  const signOut = menu?.getMenuItemById('sign-out');
  if (signIn) signIn.enabled = state !== 'signed-in';
  if (signOut) signOut.enabled = state === 'signed-in';
  for (const id of ['sync-now', 'reset-sync']) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = state === 'signed-in';
  }
}

/** Account errors carry user-facing text; anything else gets a generic message (no internals over IPC). */
async function accountCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(error instanceof AccountError ? error.message : 'Something went wrong talking to the server.');
  }
}

/** Sign In… from the menu: show the Account panel (so progress and errors are visible) and start. */
function menuSignIn(): void {
  sendCommand('account');
  void account.signIn().catch(() => undefined); // the error is shown in the panel via status
}

const defaultLibraryDir = () => path.join(app.getPath('documents'), 'Margin');

/**
 * Library folder: MARGIN_LIBRARY_DIR (tests), else the folder chosen with
 * "Choose Documents Folder…", else ~/Documents/Margin. A remembered folder that
 * no longer exists (e.g. an unplugged drive) falls back to the default rather
 * than being recreated in place.
 */
function initialLibraryDir(): string {
  if (process.env.MARGIN_LIBRARY_DIR) return path.resolve(process.env.MARGIN_LIBRARY_DIR);
  const chosen = settings.get().libraryDir;
  if (chosen) {
    try {
      if (statSync(chosen).isDirectory()) return chosen;
    } catch {
      /* fall through */
    }
    console.warn(`Margin: library folder ${chosen} is missing; using the default`);
  }
  return defaultLibraryDir();
}

function createLibrary(dir: string): FileSystemLibrary {
  return new FileSystemLibrary(dir, {
    onExternalChange: broadcastExternalChange,
    // Test hook: behave like a filesystem without hard links (exFAT, SMB).
    ...(process.env.MARGIN_TEST_NO_HARDLINKS
      ? { link: async () => Promise.reject(Object.assign(new Error('link disabled'), { code: 'ENOTSUP' })) }
      : {}),
  });
}

let treeChangeTimer: NodeJS.Timeout | undefined;

/** Watches the whole library so external adds/removes/renames show up live (debounced). */
async function startTreeWatcher(root: string): Promise<void> {
  await treeWatcher?.close();
  const watcher = watchTree(root, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 64,
    // Dot-entries: our own temp files, .git, .DS_Store…
    ignored: (p: string) => p !== root && path.basename(p).startsWith('.'),
  });
  watcher.on('all', () => {
    sync?.nudge(); // a local change: sync soon (debounced)
    clearTimeout(treeChangeTimer);
    treeChangeTimer = setTimeout(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.libraryChanged);
      }
    }, 150);
  });
  watcher.on('error', (error) => console.error('Margin: library watcher error', error));
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  treeWatcher = watcher;
}

function sendCommand(command: AppCommand, win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.command, command);
}

function parseContextMenuItems(raw: unknown): ContextMenuItem[] {
  if (!Array.isArray(raw) || raw.length > 30) throw new TypeError('Bad context menu');
  return raw.map((item: unknown) => {
    const i = item as Record<string, unknown>;
    if (i?.type === 'separator') return { type: 'separator' as const };
    if (typeof i?.id !== 'string' || typeof i.label !== 'string' || i.label.length > 100) {
      throw new TypeError('Bad context menu item');
    }
    return { id: i.id, label: i.label, enabled: i.enabled !== false };
  });
}

function popupContextMenu(win: BrowserWindow, items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const menu = Menu.buildFromTemplate(
      items.map((item) =>
        'type' in item
          ? { type: 'separator' as const }
          : { label: item.label, enabled: item.enabled !== false, click: () => (chosen = item.id) },
      ),
    );
    // On macOS the click can arrive just after the close callback; give it a tick.
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(chosen), 0) });
  });
}

let switchingLibrary = false;

/** File > Choose Documents Folder…: flush, confirm if needed, switch, reload windows. */
async function chooseLibraryFolder(): Promise<void> {
  if (switchingLibrary) return;
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: 'Choose Documents Folder',
    buttonLabel: 'Use Folder',
    defaultPath: library.root,
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const dir = result.filePaths[0];
  if (result.canceled || !dir || path.resolve(dir) === library.root) return;

  switchingLibrary = true;
  try {
    const outcomes = await Promise.all(BrowserWindow.getAllWindows().map((w) => flushWindow(w)));
    const unsaved = outcomes.filter((o) => !o.clean);
    if (unsaved.length > 0 && !(await confirmDiscard(unsaved, 'Switch', parent))) return;
    await library.idle();
    library.dispose();
    library = createLibrary(path.resolve(dir));
    await library.init();
    await startTreeWatcher(library.root);
    await settings.update({ libraryDir: library.root, lastDocument: '' });
    void sync.syncNow(); // a different folder has its own base
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.reload();
  } finally {
    switchingLibrary = false;
  }
}

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
const flushWaiters = new Map<number, (result: FlushResult) => void>();

/** Outcome of flushing one window: what the renderer reported, or that it was unresponsive. */
type FlushOutcome = FlushResult | { clean: true; unresponsive: true };

function parseFlushResult(raw: unknown): FlushResult {
  if (typeof raw !== 'object' || raw === null) return { clean: false };
  const r = raw as Record<string, unknown>;
  return {
    clean: r.clean === true,
    path: typeof r.path === 'string' ? r.path : undefined,
    unsavedText: typeof r.unsavedText === 'string' ? r.unsavedText : undefined,
  };
}

/**
 * Asks the window's renderer to push any unsaved editor text through `save`
 * and waits for it to confirm, then waits for the write queue to drain.
 * A renderer that doesn't answer in time is destroyed (not closed: closing
 * waits for its unload handlers, which a hung page never runs).
 */
function flushWindow(win: BrowserWindow, opts: { timeoutMs?: number; destroyOnTimeout?: boolean } = {}): Promise<FlushOutcome> {
  if (win.isDestroyed() || win.webContents.isCrashed()) {
    return library.idle().then(() => ({ clean: true, unresponsive: true }) as const);
  }
  const id = ++flushSeq;
  const timeoutMs = opts.timeoutMs ?? FLUSH_TIMEOUT_MS;
  return new Promise<FlushOutcome>((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters.delete(id);
      if (opts.destroyOnTimeout === false) return resolve({ clean: true, unresponsive: true });
      console.warn(`Margin: renderer did not confirm flush within ${timeoutMs}ms; destroying its window`);
      if (!win.isDestroyed()) win.destroy();
      resolve({ clean: true, unresponsive: true });
    }, timeoutMs);
    flushWaiters.set(id, (result) => {
      clearTimeout(timer);
      flushWaiters.delete(id);
      resolve(result);
    });
    win.webContents.send(IPC_CHANNELS.flushRequest, id);
  }).then(async (outcome) => {
    await library.idle();
    return outcome;
  });
}

/**
 * Some text couldn't be saved. Ask before discarding it; Cancel is the default.
 * Returns true if it's OK to proceed with closing/quitting.
 */
async function confirmDiscard(
  unsaved: FlushResult[],
  action: 'Quit' | 'Close' | 'Switch',
  parent?: BrowserWindow,
): Promise<boolean> {
  const first = unsaved[0]!;
  const name = first.path ? basename(first.path) : 'your document';
  const options = {
    type: 'warning' as const,
    message: "Margin couldn't save your changes.",
    detail:
      `Your latest changes to “${name}” could not be written to disk (the folder may be read-only, ` +
      `offline or full). If you ${action.toLowerCase()} now, those changes will be lost.`,
    buttons: ['Cancel', ...(first.unsavedText !== undefined ? ['Save a Copy…'] : []), `${action} Anyway`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  const label = options.buttons[response];
  if (label === `${action} Anyway`) return true;
  if (label !== 'Save a Copy…') return false;

  const stem = first.path ? displayName(first.path) : 'Untitled';
  const save = await dialog.showSaveDialog({
    title: 'Save a Copy',
    defaultPath: path.join(app.getPath('documents'), `${stem} (unsaved copy).md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (save.canceled || !save.filePath) return false;
  try {
    // A location the user picked explicitly; exclusive create so we never clobber.
    await fs.writeFile(save.filePath, first.unsavedText ?? '', { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    dialog.showErrorBox("Couldn't save the copy", `${save.filePath}: ${(error as Error).message}`);
    return false;
  }
}

let quitReady = false;
let quitting = false;

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    let proceed = true;
    try {
      const outcomes = await Promise.all(BrowserWindow.getAllWindows().map((w) => flushWindow(w)));
      await Promise.all([library?.idle(), settings?.idle(), treeWatcher?.close()]);
      const unsaved = outcomes.filter((o) => !o.clean);
      if (unsaved.length > 0) proceed = await confirmDiscard(unsaved, 'Quit');
    } catch (error) {
      console.error('Margin: flush before quit failed', error);
    }
    if (!proceed) {
      quitting = false; // user cancelled; keep running
      return;
    }
    quitReady = true;
    sync?.stop();
    library?.dispose();
    app.quit();
  })();
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
  // MARGIN_TEST_LIST_LIMIT: lower the listing cap so tests can see the truncation notice.
  const listLimit = Number(process.env.MARGIN_TEST_LIST_LIMIT) || undefined;
  handle(IPC_CHANNELS.libraryTree, () => library.listTree(listLimit));
  handle(IPC_CHANNELS.libraryCreateDocument, (p: string) => library.createDocument(p));
  handle(IPC_CHANNELS.libraryReveal, async (p: string) => shell.showItemInFolder(await library.resolve(p)));
  ipcMain.handle(IPC_CHANNELS.libraryContextMenu, (event, items: unknown) => {
    assertTrustedSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    return popupContextMenu(win, parseContextMenuItems(items));
  });
  handle(IPC_CHANNELS.settingsLoad, async () => settings.get());
  // Not via handle(): the patch is an object, validated by parseSettingsPatch inside update().
  // The library folder can only change through the native folder picker.
  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, patch: unknown) => {
    assertTrustedSender(event);
    if (typeof patch === 'object' && patch !== null) {
      const { libraryDir: _ignored, serverUrl: _ignoredToo, ...rest } = patch as Record<string, unknown>;
      return settings.update(rest);
    }
    return settings.get();
  });
  handle(IPC_CHANNELS.toggleFullScreen, async () => toggleFullScreen());
  handle(IPC_CHANNELS.accountStatus, async () => account.status());
  handle(IPC_CHANNELS.accountSignIn, () => accountCall(() => account.signIn()));
  handle(IPC_CHANNELS.accountSignOut, () => accountCall(() => account.signOut()));
  handle(IPC_CHANNELS.accountDevices, () => accountCall(() => account.listDevices()));
  handle(IPC_CHANNELS.accountRevoke, (id: string) => accountCall(() => account.revokeDevice(id)));
  handle(IPC_CHANNELS.syncStatus, async () => sync.status());
  handle(IPC_CHANNELS.syncNow, () => sync.syncNow());

  ipcMain.on(IPC_CHANNELS.flushDone, (event, id: unknown, result: unknown) => {
    try {
      assertTrustedSender(event);
    } catch {
      return;
    }
    if (typeof id === 'number') flushWaiters.get(id)?.(parseFlushResult(result));
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
  set('sidebar', s.sidebar);
  set(`library-sort-${s.librarySort}`, true);
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
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { id: 'sign-in', label: 'Sign In…', click: () => menuSignIn() },
        { id: 'sign-out', label: 'Sign Out', click: () => void account.signOut().catch(() => undefined) },
        { id: 'account', label: 'Account and Devices…', click: () => sendCommand('account') },
        { id: 'sync-now', label: 'Sync Now', accelerator: 'CommandOrControl+Alt+S', click: () => void sync.syncNow() },
        { id: 'reset-sync', label: 'Reset Sync State for This Folder…', click: () => void confirmResetSync() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { id: 'new-document', label: 'New Document', accelerator: 'CommandOrControl+N', click: () => sendCommand('new-document') },
        { id: 'new-folder', label: 'New Folder', accelerator: 'CommandOrControl+Shift+N', click: () => sendCommand('new-folder') },
        { id: 'quick-open', label: 'Quick Open…', accelerator: 'CommandOrControl+P', click: () => sendCommand('quick-open') },
        { type: 'separator' },
        { id: 'choose-library', label: 'Choose Documents Folder…', click: () => void chooseLibraryFolder() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: 'sidebar',
          label: 'Show Library',
          type: 'checkbox',
          accelerator: 'CommandOrControl+\\',
          checked: settings.get().sidebar,
          // The sidebar never shows in focus mode: asking for it leaves focus mode.
          click: () =>
            updateSettings(
              settings.get().focusMode ? { focusMode: false, sidebar: true } : { sidebar: !settings.get().sidebar },
            ),
        },
        {
          label: 'Sort Library By',
          submenu: [
            {
              id: 'library-sort-name',
              label: 'Name',
              type: 'radio',
              checked: settings.get().librarySort === 'name',
              click: () => updateSettings({ librarySort: 'name' }),
            },
            {
              id: 'library-sort-modified',
              label: 'Date Modified',
              type: 'radio',
              checked: settings.get().librarySort === 'modified',
              click: () => updateSettings({ librarySort: 'modified' }),
            },
          ],
        },
        { type: 'separator' },
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
  updateAccountMenu();
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
    void (async () => {
      const outcome = await flushWindow(win).catch(() => ({ clean: false }) as FlushResult);
      if (!outcome.clean && !(await confirmDiscard([outcome], 'Close', win))) {
        closing = false;
        return;
      }
      closeReady = true;
      if (!win.isDestroyed()) win.close();
    })();
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
  settings = new SettingsFile(path.join(app.getPath('userData'), 'settings.json'));
  await settings.load();
  // Tests: no first-run welcome document unless a test asks for it.
  if (process.env.MARGIN_TEST_SKIP_WELCOME && !settings.get().welcomed) await settings.update({ welcomed: true });
  settings.onChange(applySettings);
  // Account: reads the local encrypted session only; no network at startup.
  account = createAccount();
  await account.load();
  library = createLibrary(initialLibraryDir());
  await library.init();
  await startTreeWatcher(library.root);
  // No camera, mic, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  if (!DEV_SERVER_URL) handleAppScheme(webRoot());
  sync = createSync();
  registerIpc();
  buildMenu();
  createWindow();
  sync.start(); // no-op while signed out

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
