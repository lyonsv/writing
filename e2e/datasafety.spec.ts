/**
 * Data-safety regression suite (from the M1 validation). Each test launches a
 * fresh app against a fresh temp library folder.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { currentDocument, dialogCalls, launch, newLibrary, quitAndWait, stubDialogs } from './launch';

const openedFile = async (page: import('@playwright/test').Page, lib: string) =>
  path.join(lib, await currentDocument(page));

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('existing content is loaded and not overwritten on startup', async () => {
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  const original = '# Existing\n\nDo not lose me.\n'.repeat(2000);
  writeFileSync(file, original);
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText('Do not lose me.');
  await sleep(1500);
  expect(read(file)).toBe(original);
  await quitAndWait(app);
  expect(read(file)).toBe(original);
});

test('typing then quitting immediately (before the debounce) saves the text', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await page.locator('.cm-content').click();
  await page.keyboard.type('saved at quit');
  await quitAndWait(app);
  expect(read(file)).toBe('saved at quit');
});

test('typing then closing the window immediately saves the text', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await page.locator('.cm-content').click();
  await page.keyboard.type('saved at close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => read(file), { timeout: 10_000 }).toBe('saved at close');
  await quitAndWait(app);
  expect(read(file)).toBe('saved at close');
});

test('large document (20 MB): typing then quitting immediately saves the edit', async () => {
  test.setTimeout(120_000);
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  const big = 'x'.repeat(20_000_000) + '\n';
  writeFileSync(file, big);
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (document.querySelector('.cm-content') as HTMLElement).focus());
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('TAIL');
  await quitAndWait(app);
  const text = read(file);
  expect(text?.length).toBe(big.length + 4);
  expect(text?.endsWith('\nTAIL')).toBe(true);
});

test('external edit while the editor is clean reloads the editor; later typing builds on it', async () => {
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  writeFileSync(file, 'v1\n');
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText('v1');
  writeFileSync(file, 'v1\nEXTERNAL EDIT\n');
  await expect(page.locator('.cm-content')).toContainText('EXTERNAL EDIT', { timeout: 5000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('local');
  await expect.poll(() => read(file), { timeout: 10_000 }).toBe('v1\nEXTERNAL EDIT\nlocal');
  expect(readdirSync(lib).filter((f) => f.includes('conflict'))).toEqual([]);
  await quitAndWait(app);
  expect(read(file)).toBe('v1\nEXTERNAL EDIT\nlocal');
});

test('external edit while there are unsaved edits keeps both copies', async () => {
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  writeFileSync(file, 'base\n');
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText('base');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('ours');
  writeFileSync(file, 'base\ntheirs\n'); // lands inside the editor's debounce window
  await expect(page.getByTestId('save-status')).toContainText('Changed elsewhere', { timeout: 10_000 });
  await page.keyboard.type(' and more');
  await quitAndWait(app);

  expect(read(file)).toBe('base\ntheirs\n');
  const copies = readdirSync(lib).filter((f) => / \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/.test(f));
  expect(copies).toHaveLength(1);
  expect(read(path.join(lib, copies[0]!))).toBe('base\nours and more');
});

test('concurrent writes: the later write always wins', async () => {
  test.setTimeout(180_000);
  const lib = newLibrary();
  const file = path.join(lib, 'race.md');
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible();
  const stale: number[] = [];
  for (let i = 0; i < 20; i++) {
    await page.evaluate(async () => {
      const s = (window as unknown as { marginDesktop: { store: { write(p: string, c: string): Promise<void> } } })
        .marginDesktop.store;
      await Promise.all([s.write('race.md', 'OLD'.repeat(10_000_000)), s.write('race.md', 'NEW')]);
    });
    if (read(file) !== 'NEW') stale.push(i);
  }
  expect(stale).toEqual([]);
  await quitAndWait(app);
});

test('only .md documents can be written; hidden and escaping paths are refused', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible();
  const results = await page.evaluate(async () => {
    const s = (window as unknown as { marginDesktop: { store: { write(p: string, c: string): Promise<void> } } })
      .marginDesktop.store;
    const out: Record<string, string> = {};
    for (const p of ['evil.sh', '.hidden', '.hidden.md', 'sub/../../x.md', 'a//b.md']) {
      try {
        await s.write(p, 'x');
        out[p] = 'allowed';
      } catch (e) {
        const m = (e as Error).message;
        out[p] = m.includes('outside the library root') ? 'outside-root' : m.includes('not allowed') ? 'disallowed' : m;
      }
    }
    return out;
  });
  expect(results).toEqual({
    'evil.sh': 'disallowed',
    '.hidden': 'disallowed',
    '.hidden.md': 'disallowed',
    'sub/../../x.md': 'outside-root',
    'a//b.md': 'allowed', // normalised to a/b.md
  });
  expect(existsSync(path.join(lib, 'a/b.md'))).toBe(true);
  expect(existsSync(path.join(lib, 'evil.sh'))).toBe(false);
  await quitAndWait(app);
});

test('a failing save shows "Not saved", retries, and recovers', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => read(file)).toBe('');
  chmodSync(lib, 0o555); // atomic writes need to create a temp file here
  try {
    await page.locator('.cm-content').click();
    await page.keyboard.type('retry me');
    await expect(page.getByTestId('save-status')).toHaveText(/Not saved/, { timeout: 10_000 });
  } finally {
    chmodSync(lib, 0o755);
  }
  // While the retry is pending the indicator must stay up; then the save lands and it goes away.
  await expect(page.getByTestId('save-status')).toHaveText(/Not saved/);
  await expect.poll(() => read(file), { timeout: 15_000 }).toBe('retry me');
  await expect(page.getByTestId('save-status')).toHaveCount(0, { timeout: 5_000 });
  await quitAndWait(app);
});

test('filesystems without hard links (exFAT, SMB): create, save and conflict copies still work', async () => {
  // hdiutil can't create a real exFAT volume in CI sandboxes, so main is told
  // to fail link() with ENOTSUP, exactly as exFAT does.
  const lib = newLibrary();
  const app = await launch(lib, { MARGIN_TEST_NO_HARDLINKS: '1' });
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => read(file)).toBe('');
  await page.locator('.cm-content').click();
  await page.keyboard.type('first');
  await expect.poll(() => read(file)).toBe('first');
  writeFileSync(file, 'theirs');
  await expect(page.locator('.cm-content')).toContainText('theirs');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' ours');
  writeFileSync(file, 'theirs again'); // inside the debounce: conflict
  await expect(page.getByTestId('save-status')).toContainText('Changed elsewhere', { timeout: 10_000 });
  await quitAndWait(app);
  expect(read(file)).toBe('theirs again');
  const copies = readdirSync(lib).filter((f) => f.includes('(conflict '));
  expect(copies).toHaveLength(1);
  expect(read(path.join(lib, copies[0]!))).toBe('theirs ours');
  expect(readdirSync(lib).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

test('a hung renderer does not block quit beyond the flush timeout', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await page.locator('.cm-content').click();
  await page.keyboard.type('saved before the hang');
  await expect.poll(() => read(file)).toBe('saved before the hang');
  await page.evaluate(() => {
    setTimeout(() => {
      for (;;) {
        /* hang the renderer's main thread */
      }
    }, 50);
  });
  await sleep(200);
  const started = Date.now();
  await quitAndWait(app);
  const took = Date.now() - started;
  expect(took).toBeLessThan(12_000); // 5 s flush timeout + teardown
  expect(read(file)).toBe('saved before the hang');
});

test('closing a window whose renderer is hung destroys it after the timeout', async () => {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.evaluate(() => {
    setTimeout(() => {
      for (;;) {
        /* hang */
      }
    }, 50);
  });
  await sleep(200);
  const started = Date.now();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 12_000 })
    .toBe(0);
  expect(Date.now() - started).toBeLessThan(12_000);
  await quitAndWait(app);
});

/** Opens a fresh library, makes it read-only and types, so the save keeps failing. */
async function failingSave(text: string) {
  const lib = newLibrary();
  const app = await launch(lib);
  const page = await app.firstWindow();
  const file = await openedFile(page, lib);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => read(file)).toBe('');
  chmodSync(lib, 0o555);
  await page.locator('.cm-content').click();
  await page.keyboard.type(text);
  await expect(page.getByTestId('save-status')).toHaveText(/Not saved/, { timeout: 10_000 });
  return { lib, file, app, page, restore: () => chmodSync(lib, 0o755) };
}

test('quitting while a save is failing asks first; Cancel (the default) keeps the app and the text', async () => {
  const { file, app, page, restore } = await failingSave('precious words');
  try {
    await stubDialogs(app, { choose: 'Cancel' });
    await app.evaluate(({ app: a }) => a.quit());
    await expect.poll(() => dialogCalls(app).then((c) => c.length), { timeout: 10_000 }).toBe(1);
    const [call] = await dialogCalls(app);
    expect(call).toEqual({
      message: "Margin couldn't save your changes.",
      buttons: ['Cancel', 'Save a Copy…', 'Quit Anyway'],
      defaultId: 0,
    });
    await sleep(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.locator('.cm-content')).toContainText('precious words');
  } finally {
    restore();
  }
  // Once the folder is writable again the retry lands, and quit no longer asks.
  await expect.poll(() => read(file), { timeout: 20_000 }).toBe('precious words');
  await quitAndWait(app);
  expect(read(file)).toBe('precious words');
});

test('quitting while a save is failing: "Save a Copy…" writes the text elsewhere, then quits', async () => {
  const { app, file, restore } = await failingSave('rescue me');
  const copy = path.join(newLibrary(), 'rescued.md');
  try {
    await stubDialogs(app, { choose: 'Save a Copy…', savePath: copy });
    await quitAndWait(app);
    expect(read(copy)).toBe('rescue me');
    expect(read(file)).toBe('');
  } finally {
    restore();
  }
});

test('quitting while a save is failing: "Quit Anyway" quits', async () => {
  const { app, restore } = await failingSave('let it go');
  try {
    await stubDialogs(app, { choose: 'Quit Anyway' });
    await quitAndWait(app);
  } finally {
    restore();
  }
});

test('closing the window while a save is failing asks too; Cancel keeps the window', async () => {
  const { app, restore } = await failingSave('keep the window');
  try {
    await stubDialogs(app, { choose: 'Cancel' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => dialogCalls(app).then((c) => c.map((x) => x.buttons.at(-1))), { timeout: 10_000 }).toEqual([
      'Close Anyway',
    ]);
    await sleep(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    restore();
  }
  await quitAndWait(app);
});

test('CRLF files stay CRLF after editing (and a UTF-8 BOM survives)', async () => {
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  writeFileSync(file, '﻿# Title\r\n\r\nBody\r\n');
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText('Body');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('more');
  await page.keyboard.press('Enter');
  await page.keyboard.type('last');
  await expect.poll(() => read(file)).toBe('﻿# Title\r\n\r\nBody\r\nmore\r\nlast');
  await quitAndWait(app);
  expect(read(file)).toBe('﻿# Title\r\n\r\nBody\r\nmore\r\nlast');
});

test('non-UTF-8 files open read-only with a notice and are never rewritten', async () => {
  const lib = newLibrary();
  const file = path.join(lib, 'Untitled.md');
  const latin1 = Buffer.from('# Caf\xe9\n\nNa\xefve text.\n', 'latin1');
  writeFileSync(file, latin1);
  const app = await launch(lib);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toContainText('Café');
  await expect(page.getByTestId('save-status')).toContainText('Read-only');
  await page.locator('.cm-content').click();
  await page.keyboard.type('typing does nothing');
  await expect(page.locator('.cm-content')).not.toContainText('typing does nothing');
  const direct = await page.evaluate(async () => {
    const d = (window as unknown as { marginDesktop: { documents: { save(p: string, c: string): Promise<unknown> } } })
      .marginDesktop.documents;
    try {
      await d.save('Untitled.md', 'overwrite');
      return 'allowed';
    } catch (e) {
      return (e as Error).message.includes('not UTF-8') ? 'refused' : (e as Error).message;
    }
  });
  expect(direct).toBe('refused');
  // Read-only notice stays visible in focus mode too.
  await app.evaluate(({ BrowserWindow, Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('focus-mode')!.click(undefined, BrowserWindow.getAllWindows()[0]),
  );
  await expect(page.getByTestId('save-status')).toContainText('Read-only');
  await quitAndWait(app);
  expect(readFileSync(file).equals(latin1)).toBe(true);
});
