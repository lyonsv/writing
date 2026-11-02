import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Launches the built desktop app. By default it uses the packaged
 * `Margin.app` produced by `pnpm build:desktop`; set MARGIN_E2E_UNPACKED=1 to
 * run `apps/desktop/dist/main.js` with the Electron binary instead. Either way
 * the renderer is the static Expo export served over app://.
 */
const repo = path.resolve(import.meta.dirname, '..');
// The electron package lives in apps/desktop, not at the repo root.
const electronBinary = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron') as unknown as string;
const packagedCandidates = ['mac-arm64', 'mac', 'mac-universal'].map((d) =>
  path.join(repo, 'apps/desktop/release', d, 'Margin.app/Contents/MacOS/Margin'),
);

function launchOptions(env: Record<string, string>): Parameters<typeof electron.launch>[0] {
  const packaged = packagedCandidates.find((p) => existsSync(p));
  const baseEnv = { ...process.env, ...env } as Record<string, string>;
  delete baseEnv.MARGIN_DEV_SERVER_URL;
  if (packaged && !process.env.MARGIN_E2E_UNPACKED) {
    return { executablePath: packaged, args: [], env: baseEnv };
  }
  return { executablePath: electronBinary, args: [path.join(repo, 'apps/desktop/dist/main.js')], env: baseEnv };
}

let app: ElectronApplication;
let page: Page;
let libraryDir: string;
let userDataDir: string;

test.beforeAll(async () => {
  libraryDir = mkdtempSync(path.join(tmpdir(), 'margin-lib-'));
  userDataDir = mkdtempSync(path.join(tmpdir(), 'margin-userdata-'));
  app = await electron.launch(launchOptions({ MARGIN_LIBRARY_DIR: libraryDir, MARGIN_USER_DATA_DIR: userDataDir, MARGIN_SHOW_INACTIVE: '1' }));
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log(`[renderer] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer] ${m.type()}: ${m.text()}`);
  });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(libraryDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
});

test('loads the static export over app:// with a hidden-inset window', async () => {
  expect(page.url()).toBe('app://bundle/');
  const info = await app.evaluate(({ app: electronApp, BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-fullscreen');
    return {
      packaged: electronApp.isPackaged,
      fullscreenable: win.isFullScreenable(),
      accelerator: item?.accelerator,
      label: item?.label,
    };
  });
  const expectPackaged = !process.env.MARGIN_E2E_UNPACKED && packagedCandidates.some((p) => existsSync(p));
  expect(info).toEqual({ packaged: expectPackaged, fullscreenable: true, accelerator: 'Control+Command+F', label: 'Enter Full Screen' });
});

test('types into the editor and saves to a .md file', async () => {
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  const text = '# Hello Margin\n\nWritten by the smoke test.';
  await page.keyboard.type(text);
  await expect(editor).toContainText('Hello Margin');
  await expect(editor).toContainText('Written by the smoke test.');

  const file = path.join(libraryDir, 'Untitled.md');
  await expect.poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : null), { timeout: 10_000 }).toBe(text);
});

test('editor uses IBM Plex Mono at ~18px with a centred measure', async () => {
  const style = await page.evaluate(async () => {
    await document.fonts.ready;
    const content = document.querySelector('.cm-content') as HTMLElement;
    const scroller = document.querySelector('.cm-scroller') as HTMLElement;
    const cs = getComputedStyle(scroller);
    return {
      fontLoaded: document.fonts.check('18px "IBM Plex Mono"'),
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      maxWidth: getComputedStyle(content).maxWidth,
    };
  });
  expect(style.fontFamily).toContain('IBM Plex Mono');
  expect(style.fontLoaded).toBe(true);
  expect(style.fontSize).toBe('18px');
  expect(parseFloat(style.lineHeight)).toBeCloseTo(18 * 1.6, 0);
  expect(style.maxWidth).toMatch(/px$/);
});

test('dims markdown syntax markers', async () => {
  const colors = await page.evaluate(() => {
    const line = document.querySelector('.cm-line') as HTMLElement;
    const spans = Array.from(line.querySelectorAll('span'));
    const mark = spans.find((s) => s.textContent === '#');
    return { mark: mark && getComputedStyle(mark).color, text: getComputedStyle(line).color };
  });
  expect(colors.mark).toBeDefined();
  expect(colors.mark).not.toBe(colors.text);
});

test('main process rejects paths outside the library root', async () => {
  const results = await page.evaluate(async () => {
    const store = (window as unknown as { marginDesktop: { store: Record<string, (...a: string[]) => Promise<unknown>> } })
      .marginDesktop.store;
    const attempts: Array<[string, string[]]> = [
      ['read', ['../../../etc/passwd']],
      ['read', ['/etc/passwd']],
      ['write', ['../escape.md', 'x']],
      ['rename', ['Untitled.md', '../moved.md']],
      ['delete', ['..']],
      ['list', ['..']],
    ];
    const out: string[] = [];
    for (const [method, args] of attempts) {
      try {
        await store[method]!(...args);
        out.push(`${method}: allowed`);
      } catch (e) {
        out.push(`${method}: ${String((e as Error).message).includes('outside the library root') ? 'rejected' : (e as Error).message}`);
      }
    }
    return out;
  });
  expect(results).toEqual([
    'read: rejected',
    'read: rejected',
    'write: rejected',
    'rename: rejected',
    'delete: rejected',
    'list: rejected',
  ]);
  expect(existsSync(path.join(path.dirname(libraryDir), 'escape.md'))).toBe(false);
});

test('follows the OS colour scheme', async () => {
  const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('.cm-editor')!).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await bg();
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await bg();
  expect(light).toBe('rgb(251, 251, 250)');
  expect(dark).toBe('rgb(27, 27, 28)');
});
