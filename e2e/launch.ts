import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const repo = path.resolve(import.meta.dirname, '..');
const electronBinary = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron') as unknown as string;

export const newLibrary = () => mkdtempSync(path.join(tmpdir(), 'margin-e2e-lib-'));

/**
 * Launches the built main process (`apps/desktop/dist/main.js`) with the stock
 * Electron binary, serving the static Expo export over app://.
 *
 * The packaged Margin.app can't be driven by Playwright: its Electron fuses
 * disable `--inspect`/`--remote-debugging` style attachment. It is checked
 * separately by `pnpm --filter @margin/desktop verify:packaged`.
 */
export const newUserData = () => mkdtempSync(path.join(tmpdir(), 'margin-e2e-ud-'));

export async function launch(
  libraryDir: string,
  extraEnv: Record<string, string> = {},
  userDataDir: string = newUserData(),
): Promise<ElectronApplication> {
  const env = {
    ...process.env,
    MARGIN_LIBRARY_DIR: libraryDir,
    MARGIN_USER_DATA_DIR: userDataDir,
    MARGIN_SHOW_INACTIVE: '1',
    ...extraEnv,
  } as Record<string, string>;
  delete env.MARGIN_DEV_SERVER_URL;
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [path.join(repo, 'apps/desktop/dist/main.js')],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log(`[renderer] pageerror: ${e.message}`));
  return app;
}

/** Quits via app.quit() (like Cmd+Q) and waits for the process to exit. */
export async function quitAndWait(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  await app.evaluate(({ app: a }) => a.quit());
  await exited;
}

/** Clicks an application-menu item by id, as a user would. */
export async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow, Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, id);
}

/**
 * Replaces the native dialogs in the main process (Playwright can't click them).
 * `choose` is the message-box button label to press; `savePath` answers the save dialog.
 */
export async function stubDialogs(app: ElectronApplication, cfg: { choose: string; savePath?: string }): Promise<void> {
  await app.evaluate(({ dialog }, c) => {
    const g = globalThis as unknown as { __dialogCalls: unknown[] };
    g.__dialogCalls = [];
    const d = dialog as unknown as Record<string, unknown>;
    d.showMessageBox = async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { buttons: string[]; message: string; defaultId: number };
      g.__dialogCalls.push({ message: opts.message, buttons: opts.buttons, defaultId: opts.defaultId });
      return { response: opts.buttons.indexOf(c.choose), checkboxChecked: false };
    };
    d.showSaveDialog = async () => ({ canceled: !c.savePath, filePath: c.savePath });
  }, cfg);
}

export function dialogCalls(app: ElectronApplication): Promise<Array<{ message: string; buttons: string[]; defaultId: number }>> {
  return app.evaluate(() => (globalThis as unknown as { __dialogCalls: never[] }).__dialogCalls ?? []);
}
