import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { clickMenu, launch, newLibrary, newUserData, quitAndWait } from './launch';

const DOC = [
  '# Focus test',
  '',
  'First one here. Second, e.g. this one, is here. Third one.',
  '',
  'Another paragraph follows. It has two sentences.',
  '',
].join('\n');

async function open(content: string, userData = newUserData()): Promise<{ app: ElectronApplication; page: Page; lib: string }> {
  const lib = newLibrary();
  writeFileSync(path.join(lib, 'Untitled.md'), content);
  const app = await launch(lib, {}, userData);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText(content.split('\n')[0]!.replace(/^#+ /, ''));
  return { app, page, lib };
}

/** Puts the caret at the first occurrence of `needle` using the keyboard. */
async function caretTo(page: Page, needle: string): Promise<void> {
  const offset = await page.evaluate((n) => {
    const text = (document.querySelector('.cm-content') as HTMLElement).innerText;
    return text.indexOf(n);
  }, needle);
  expect(offset).toBeGreaterThanOrEqual(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowUp');
  // Lines are short here, so ArrowRight across line ends matches character offsets.
  for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
}

const focusState = (page: Page) =>
  page.evaluate(() => {
    const active = Array.from(document.querySelectorAll('.cm-focus-active'));
    const dim = Array.from(document.querySelectorAll('.cm-focus-dim'));
    return {
      active: active.map((e) => e.textContent).join(''),
      activeOpacity: active[0] ? getComputedStyle(active[0]).opacity : null,
      dimCount: dim.length,
      dimOpacity: dim[0] ? getComputedStyle(dim[0]).opacity : null,
      dimText: dim.map((e) => e.textContent).join('|'),
      focusModeClass: document.querySelector('.cm-editor')!.classList.contains('cm-focus-mode'),
    };
  });

test('focus mode dims everything but the current sentence, then paragraph, following the caret', async () => {
  const { app, page } = await open(DOC);
  await caretTo(page, 'Second,');
  expect((await focusState(page)).dimCount).toBe(0);

  await clickMenu(app, 'focus-mode'); // default scope: sentence
  await expect.poll(async () => (await focusState(page)).active).toBe('Second, e.g. this one, is here.');
  await page.waitForTimeout(400); // let the fade-in finish
  let s = await focusState(page);
  expect(s.activeOpacity).toBe('1');
  expect(Number(s.dimOpacity)).toBeCloseTo(0.28, 2);
  expect(s.dimText).toContain('First one here.');
  expect(s.dimText).toContain('Third one.');
  expect(s.focusModeClass).toBe(true);

  // Follows the caret.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await focusState(page)).active).toBe('Another paragraph follows.');

  await clickMenu(app, 'focus-scope-paragraph');
  await expect.poll(async () => (await focusState(page)).active).toBe('Another paragraph follows. It has two sentences.');
  await page.waitForTimeout(400);
  s = await focusState(page);
  expect(s.dimText).toContain('First one here.');

  await clickMenu(app, 'focus-scope-off'); // chrome hidden, no dimming
  await expect.poll(async () => (await focusState(page)).dimCount).toBe(0);
  expect((await focusState(page)).focusModeClass).toBe(true);

  await clickMenu(app, 'focus-scope-sentence');
  await clickMenu(app, 'focus-mode'); // off again
  await expect.poll(async () => (await focusState(page)).dimCount).toBe(0);
  s = await focusState(page);
  expect(s.focusModeClass).toBe(false);
  expect(s.active).toBe('');
  await quitAndWait(app);
});

test('menu items carry the documented shortcuts and reflect state', async () => {
  const { app } = await open(DOC);
  const items = await app.evaluate(({ Menu }) =>
    ['focus-mode', 'focus-scope-sentence', 'focus-scope-paragraph', 'focus-scope-off', 'typewriter', 'toggle-fullscreen'].map(
      (id) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
        return [id, item.accelerator, item.checked] as const;
      },
    ),
  );
  expect(items).toEqual([
    ['focus-mode', 'CommandOrControl+Shift+F', false],
    ['focus-scope-sentence', 'Alt+CommandOrControl+1', true],
    ['focus-scope-paragraph', 'Alt+CommandOrControl+2', false],
    ['focus-scope-off', 'Alt+CommandOrControl+0', false],
    ['typewriter', 'Alt+CommandOrControl+T', false],
    ['toggle-fullscreen', 'Control+Command+F', false],
  ]);
  await clickMenu(app, 'focus-scope-paragraph');
  const checked = await app.evaluate(({ Menu }) =>
    ['focus-scope-sentence', 'focus-scope-paragraph', 'focus-scope-off'].map(
      (id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.checked,
    ),
  );
  expect(checked).toEqual([false, true, false]);
  await quitAndWait(app);
});

test('code blocks stay whole and headings are one unit in sentence scope', async () => {
  const { app, page } = await open('# Title. Sub\n\nText here. More.\n\n```\nx = 1. y = 2.\nz\n```\n');
  await clickMenu(app, 'focus-mode');
  await caretTo(page, 'y = 2');
  await expect.poll(async () => (await focusState(page)).active).toBe('```x = 1. y = 2.z```');
  await caretTo(page, 'Sub');
  await expect.poll(async () => (await focusState(page)).active).toBe('# Title. Sub');
  await quitAndWait(app);
});

test('settings persist across launches (userData JSON)', async () => {
  const userData = newUserData();
  const first = await open(DOC, userData);
  await clickMenu(first.app, 'focus-mode');
  await clickMenu(first.app, 'typewriter');
  await clickMenu(first.app, 'focus-scope-paragraph');
  await quitAndWait(first.app);
  expect(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))).toEqual({
    focusMode: true,
    focusScope: 'paragraph',
    typewriter: true,
  });

  const second = await open(DOC, userData);
  await caretTo(second.page, 'It has');
  await expect.poll(async () => (await focusState(second.page)).active).toBe('Another paragraph follows. It has two sentences.');
  const checked = await second.app.evaluate(({ Menu }) =>
    ['focus-mode', 'typewriter', 'focus-scope-paragraph'].map((id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.checked),
  );
  expect(checked).toEqual([true, true, true]);
  await quitAndWait(second.app);
});

test('typewriter scrolling keeps the caret line near the vertical centre', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Line ${i}. Some text to type after.`);
  const { app, page } = await open(`# Typewriter\n\n${lines.join('\n')}\n`);
  await clickMenu(app, 'typewriter');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowUp');

  const offsetFromCentre = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller') as HTMLElement;
      const caret = document.querySelector('.cm-cursor') as HTMLElement | null;
      const sel = window.getSelection();
      const rect = caret?.getBoundingClientRect() ?? sel!.getRangeAt(0).getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - (box.top + box.height / 2));
    });

  for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  expect(await offsetFromCentre()).toBeLessThan(30); // within about one line (18px × 1.6)
  await page.keyboard.type(' typed');
  await page.keyboard.press('Enter');
  await page.keyboard.type('new line');
  await page.waitForTimeout(200);
  expect(await offsetFromCentre()).toBeLessThan(30);
  // Even the first line can be centred (padding).
  await page.keyboard.press('Meta+ArrowUp');
  await page.waitForTimeout(200);
  expect(await offsetFromCentre()).toBeLessThan(30);

  // Off: no forced centring, so jumping to the end puts the caret near the bottom.
  await clickMenu(app, 'typewriter');
  await page.keyboard.press('Meta+ArrowDown');
  await page.waitForTimeout(200);
  expect(await offsetFromCentre()).toBeGreaterThan(60);
  await quitAndWait(app);
});

test('"Not saved" still shows in focus mode; other notices do not', async () => {
  const { app, page, lib } = await open(DOC);
  await clickMenu(app, 'focus-mode');
  chmodSync(lib, 0o555);
  try {
    await caretTo(page, 'Third');
    await page.keyboard.type('X');
    await expect(page.getByTestId('save-status')).toHaveText(/Not saved/, { timeout: 10_000 });
  } finally {
    chmodSync(lib, 0o755);
  }
  await expect(page.getByTestId('save-status')).toHaveCount(0, { timeout: 15_000 });
  await quitAndWait(app);
});

test('no long tasks while typing in a 20 MB document with focus + typewriter on', async () => {
  test.setTimeout(180_000);
  const para = 'Lorem ipsum dolor sit amet, e.g. consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore. ';
  const paragraph = para.repeat(3).trim();
  const count = Math.ceil(20_000_000 / (paragraph.length + 2));
  const big = `# Big\n\n${Array.from({ length: count }, () => paragraph).join('\n\n')}\n`;
  expect(big.length).toBeGreaterThan(20_000_000);
  const { app, page } = await open(big);
  await clickMenu(app, 'focus-mode');
  await clickMenu(app, 'typewriter');
  await page.locator('.cm-content').click();
  // Jump into the middle of the document.
  await page.evaluate(() => {
    // EditorView.findFromDOM, without importing CodeMirror into the test page.
    const content = document.querySelector('.cm-content') as HTMLElement & { cmTile?: { root?: { view: unknown } } };
    const view = content.cmTile?.root?.view as {
      state: { doc: { length: number } };
      dispatch(spec: unknown): void;
      focus(): void;
    };
    const mid = Math.floor(view.state.doc.length / 2);
    view.dispatch({ selection: { anchor: mid }, scrollIntoView: true });
    view.focus();
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as unknown as { __long: number[] }).__long.push(e.duration);
    }).observe({ type: 'longtask' });
  });
  const started = Date.now();
  await page.keyboard.type('The quick brown fox jumps over the lazy dog. ', { delay: 20 });
  const elapsed = Date.now() - started;
  await page.waitForTimeout(500);
  const longTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  console.log(`20MB typing: ${elapsed}ms for 45 keys; long tasks: ${JSON.stringify(longTasks.map(Math.round))}`);
  // A long task is >50ms. Allow one (the debounced save serialising 20 MB for IPC
  // after typing stops), but nothing per keystroke.
  expect(longTasks.length).toBeLessThanOrEqual(1);
  expect((await focusState(page)).active).toContain('The quick brown fox');
  await quitAndWait(app);
});
