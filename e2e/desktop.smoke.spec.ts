import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launch, newLibrary, quitAndWait } from './launch';

let app: ElectronApplication;
let page: Page;
let libraryDir: string;

test.beforeAll(async () => {
  libraryDir = newLibrary();
  app = await launch(libraryDir);
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log(`[renderer] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer] ${m.type()}: ${m.text()}`);
  });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(libraryDir, { recursive: true, force: true });
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
  expect(info).toEqual({ packaged: false, fullscreenable: true, accelerator: 'Control+Command+F', label: 'Enter Full Screen' });
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

test('View > Enter Full Screen toggles native fullscreen', async () => {
  const isFull = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
  const clickItem = () =>
    app.evaluate(({ BrowserWindow, Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('toggle-fullscreen')!;
      item.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
  expect(await isFull()).toBe(false);
  await clickItem();
  await expect.poll(isFull, { timeout: 10_000 }).toBe(true);
  await clickItem();
  await expect.poll(isFull, { timeout: 10_000 }).toBe(false);
});

test('quote markers and link brackets are dimmed like other markers', async () => {
  const lib = newLibrary();
  writeFileSync(path.join(lib, 'Untitled.md'), '# Title\n\n> A quote\n\nSee [a link](https://example.com).\n');
  const other = await launch(lib);
  const p = await other.firstWindow();
  await expect(p.locator('.cm-content')).toContainText('A quote');
  const colors = await p.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.cm-line span'));
    const colorOf = (text: string) => {
      const el = spans.find((s) => s.textContent === text);
      return el ? getComputedStyle(el).color : null;
    };
    return {
      hash: colorOf('#'),
      quote: colorOf('>'),
      open: colorOf('['),
      close: colorOf(']'),
      text: getComputedStyle(document.querySelector('.cm-line')!).color,
    };
  });
  expect(colors.hash).not.toBeNull();
  expect(colors.hash).not.toBe(colors.text);
  expect(colors.quote).toBe(colors.hash);
  expect(colors.open).toBe(colors.hash);
  expect(colors.close).toBe(colors.hash);
  await quitAndWait(other);
  rmSync(lib, { recursive: true, force: true });
});
