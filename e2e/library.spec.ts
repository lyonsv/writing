import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  clickMenu,
  currentDocument,
  launch,
  newLibrary,
  newUserData,
  quitAndWait,
  stubContextMenuChoice,
  stubOpenDialog,
  stubTrash,
} from './launch';

const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
const row = (page: Page, p: string) => page.getByTestId(`library-row:${p}`);
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A library with a few documents; the sidebar shown. */
async function setup(files: Record<string, string>, userData = newUserData()) {
  const lib = newLibrary();
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(lib, p)), { recursive: true });
    writeFileSync(path.join(lib, p), content);
  }
  const app = await launch(lib, {}, userData);
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible();
  const trash = mkdtempSync(path.join(tmpdir(), 'margin-e2e-trash-'));
  await stubTrash(app, trash);
  return { lib, app, page, trash, userData };
}

async function showSidebar(app: ElectronApplication, page: Page) {
  await clickMenu(app, 'sidebar');
  await expect(page.getByTestId('library-sidebar')).toBeVisible();
}

async function openViaSidebar(page: Page, p: string) {
  await row(page, p).click();
  await expect.poll(() => currentDocument(page)).toBe(p);
}

test('sidebar is hidden by default, toggles with the menu (⌘\\) and never shows in focus mode', async () => {
  const { app, page } = await setup({ 'a.md': 'A' });
  await expect(page.getByTestId('library-sidebar')).toHaveCount(0);
  await showSidebar(app, page);
  await clickMenu(app, 'focus-mode');
  await expect(page.getByTestId('library-sidebar')).toHaveCount(0);
  // Asking for the library leaves focus mode.
  await clickMenu(app, 'sidebar');
  await expect(page.getByTestId('library-sidebar')).toBeVisible();
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('focus-mode')!.checked)).toBe(false);
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('sidebar')!.accelerator)).toBe(
    'CommandOrControl+\\',
  );
  await quitAndWait(app);
});

test('create documents and folders, rename inline, sort, and trash (never hard-delete)', async () => {
  const { lib, app, page, trash } = await setup({ 'b.md': 'B', 'a.md': 'A' });
  await showSidebar(app, page);

  // New document (sidebar button and File > New Document ⌘N): date-named, opened.
  await page.getByTestId('library-new-document').click();
  await expect.poll(() => currentDocument(page)).toBe(`${today()}.md`);
  await clickMenu(app, 'new-document');
  await expect.poll(() => currentDocument(page)).toBe(`${today()} 2.md`);
  expect(read(path.join(lib, `${today()} 2.md`))).toBe('');

  // New folder starts in inline rename.
  await page.getByTestId('library-new-folder').click();
  const input = page.getByTestId('library-rename-input');
  await expect(input).toBeVisible();
  await input.fill('Projects');
  await input.press('Enter');
  await expect(row(page, 'Projects')).toBeVisible();
  expect(existsSync(path.join(lib, 'Projects'))).toBe(true);

  // Rename via the context menu; invalid names are refused with a message.
  await stubContextMenuChoice(app, 'Rename…');
  await row(page, 'a.md').click({ button: 'right' });
  await page.getByTestId('library-rename-input').fill('.hidden');
  await page.getByTestId('library-rename-input').press('Enter');
  await expect(page.getByTestId('library-error')).toContainText('dot');
  await page.getByTestId('library-rename-input').fill('Alpha');
  await page.getByTestId('library-rename-input').press('Enter');
  await expect(row(page, 'Alpha.md')).toBeVisible();
  expect(read(path.join(lib, 'Alpha.md'))).toBe('A');
  expect(existsSync(path.join(lib, 'a.md'))).toBe(false);

  // Renaming onto an existing name never overwrites.
  await row(page, 'Alpha.md').click({ button: 'right' });
  await page.getByTestId('library-rename-input').fill('b');
  await page.getByTestId('library-rename-input').press('Enter');
  await expect(page.getByTestId('library-error')).toContainText('exists');
  expect(read(path.join(lib, 'b.md'))).toBe('B');
  expect(read(path.join(lib, 'Alpha.md'))).toBe('A');

  // Sort: name ↔ recent.
  const order = () =>
    page.locator('[data-testid^="library-row:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(12)));
  await expect.poll(order).toEqual(['Projects', `${today()}.md`, `${today()} 2.md`, 'Alpha.md', 'b.md']);
  await page.getByTestId('library-sort').click();
  await expect.poll(async () => (await order())[1]).toBe(`${today()} 2.md`);
  writeFileSync(path.join(lib, 'b.md'), 'B touched'); // newest now
  await expect.poll(async () => (await order())[1]).toBe('b.md');

  // Move to Trash via the context menu.
  await stubContextMenuChoice(app, 'Move to Trash');
  await row(page, 'b.md').click({ button: 'right' });
  await expect(row(page, 'b.md')).toHaveCount(0);
  expect(existsSync(path.join(lib, 'b.md'))).toBe(false);
  expect(readdirSync(trash)).toEqual(['1-b.md']);
  expect(await app.evaluate(() => (globalThis as unknown as { __trashed: string[] }).__trashed)).toEqual([
    path.join(lib, 'b.md'),
  ]);

  // Reveal in Finder.
  await stubContextMenuChoice(app, 'Reveal in Finder');
  await row(page, 'Alpha.md').click({ button: 'right' });
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __revealed?: string[] }).__revealed ?? []))
    .toEqual([path.join(lib, 'Alpha.md')]);
  await quitAndWait(app);
});

test('drag a document into a folder, and back to the root', async () => {
  const { lib, app, page } = await setup({ 'notes/keep.md': 'k', 'loose.md': 'L' });
  await showSidebar(app, page);
  await row(page, 'loose.md').dragTo(row(page, 'notes'));
  await expect.poll(() => existsSync(path.join(lib, 'notes/loose.md'))).toBe(true);
  expect(existsSync(path.join(lib, 'loose.md'))).toBe(false);
  // loose.md was the open document, so its new folder expands to keep it visible.
  await expect(row(page, 'notes/loose.md')).toBeVisible();
  await row(page, 'notes/loose.md').dragTo(page.getByTestId('library-root-drop'), { targetPosition: { x: 100, y: 400 } });
  await expect.poll(() => existsSync(path.join(lib, 'loose.md'))).toBe(true);
  expect(read(path.join(lib, 'loose.md'))).toBe('L');
  await quitAndWait(app);
});

test('external adds, removes and renames appear live', async () => {
  const { lib, app, page } = await setup({ 'a.md': 'A' });
  await showSidebar(app, page);
  writeFileSync(path.join(lib, 'from-finder.md'), 'x');
  mkdirSync(path.join(lib, 'External Folder'));
  await expect(row(page, 'from-finder.md')).toBeVisible({ timeout: 5000 });
  await expect(row(page, 'External Folder')).toBeVisible();
  rmSync(path.join(lib, 'from-finder.md'));
  await expect(row(page, 'from-finder.md')).toHaveCount(0, { timeout: 5000 });
  writeFileSync(path.join(lib, '.hidden.md'), 'x');
  writeFileSync(path.join(lib, 'image.png'), 'x');
  await page.waitForTimeout(500);
  await expect(row(page, '.hidden.md')).toHaveCount(0);
  await expect(row(page, 'image.png')).toHaveCount(0);
  await quitAndWait(app);
});

test('quick open (⌘P) fuzzy-finds documents and opens with the keyboard', async () => {
  const { app, page } = await setup({
    'Ideas.md': 'ideas',
    'projects/margin/roadmap.md': '# Roadmap\n\nship it',
    'journal/2026-11-02.md': 'diary',
  });
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('quick-open')!.accelerator)).toBe(
    'CommandOrControl+P',
  );
  await clickMenu(app, 'quick-open');
  const input = page.getByTestId('quick-open-input');
  await expect(input).toBeFocused();
  await input.fill('mar road');
  await expect(page.locator('[data-testid^="quick-open-result:"]').first()).toHaveAttribute(
    'data-testid',
    'quick-open-result:projects/margin/roadmap.md',
  );
  await input.press('Enter');
  await expect(page.getByTestId('quick-open')).toHaveCount(0);
  await expect.poll(() => currentDocument(page)).toBe('projects/margin/roadmap.md');
  await expect(page.locator('.cm-content')).toContainText('ship it');
  // Arrow keys and Escape.
  await clickMenu(app, 'quick-open');
  await page.getByTestId('quick-open-input').fill('i');
  await page.getByTestId('quick-open-input').press('ArrowDown');
  await expect(page.locator('[data-testid^="quick-open-result:"][aria-selected="true"]')).toHaveCount(1);
  await page.getByTestId('quick-open-input').press('Escape');
  await expect(page.getByTestId('quick-open')).toHaveCount(0);
  await quitAndWait(app);
});

test('switching documents with unsaved text saves it first', async () => {
  const { lib, app, page } = await setup({ 'one.md': 'one', 'two.md': 'two' });
  await showSidebar(app, page);
  await openViaSidebar(page, 'one.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' plus unsaved');
  await row(page, 'two.md').click(); // inside the 300 ms debounce
  await expect.poll(() => currentDocument(page)).toBe('two.md');
  expect(read(path.join(lib, 'one.md'))).toBe('one plus unsaved');
  await expect(page.locator('.cm-content')).toHaveText('two');
  await quitAndWait(app);
});

test('renaming or moving the open document: the editor follows and no text is lost', async () => {
  const { lib, app, page } = await setup({ 'draft.md': 'draft', 'archive/old.md': 'old' });
  await showSidebar(app, page);
  await openViaSidebar(page, 'draft.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' before');

  await stubContextMenuChoice(app, 'Rename…');
  await row(page, 'draft.md').click({ button: 'right' });
  await page.getByTestId('library-rename-input').fill('Final');
  await page.getByTestId('library-rename-input').press('Enter');
  await expect.poll(() => currentDocument(page)).toBe('Final.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' after');
  await expect.poll(() => read(path.join(lib, 'Final.md'))).toBe('draft before after');
  expect(existsSync(path.join(lib, 'draft.md'))).toBe(false);

  // Move the open document by dragging it into a folder, typing all along.
  await page.keyboard.type(' moving');
  await row(page, 'Final.md').dragTo(row(page, 'archive'));
  await expect.poll(() => currentDocument(page)).toBe('archive/Final.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' moved');
  await quitAndWait(app);
  expect(read(path.join(lib, 'archive/Final.md'))).toBe('draft before after moving moved');
  expect(existsSync(path.join(lib, 'Final.md'))).toBe(false);
});

test('trashing the open document saves it first, then opens another', async () => {
  const { app, page, trash } = await setup({ 'doomed.md': 'doomed', 'other.md': 'other' });
  await showSidebar(app, page);
  await openViaSidebar(page, 'doomed.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' last words');
  await stubContextMenuChoice(app, 'Move to Trash');
  await row(page, 'doomed.md').click({ button: 'right' });
  await expect.poll(() => currentDocument(page)).toBe('other.md');
  expect(readFileSync(path.join(trash, '1-doomed.md'), 'utf8')).toBe('doomed last words');
  await page.waitForTimeout(800);
  expect(readdirSync(trash)).toEqual(['1-doomed.md']); // and nothing recreated it
  await quitAndWait(app);
});

test('relaunch reopens the last document; a fresh library gets a date-named one', async () => {
  const userData = newUserData();
  const first = await setup({ 'a.md': 'A', 'b.md': 'B' }, userData);
  await showSidebar(first.app, first.page);
  await openViaSidebar(first.page, 'a.md');
  await quitAndWait(first.app);
  writeFileSync(path.join(first.lib, 'b.md'), 'B newer'); // most recent, but not last opened

  const again = await launch(first.lib, {}, userData);
  const page = await again.firstWindow();
  await expect.poll(() => currentDocument(page)).toBe('a.md');
  await quitAndWait(again);

  const empty = newLibrary();
  const fresh = await launch(empty);
  const freshPage = await fresh.firstWindow();
  await expect.poll(() => currentDocument(freshPage)).toBe(`${today()}.md`);
  expect(readdirSync(empty)).toEqual([`${today()}.md`]);
  await quitAndWait(fresh);
});

test('Choose Documents Folder… saves first, switches libraries and remembers the choice', async () => {
  const userData = newUserData();
  const { lib, app, page } = await setup({ 'here.md': 'here' }, userData);
  const other = newLibrary();
  writeFileSync(path.join(other, 'there.md'), 'there');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' unsaved');
  await stubOpenDialog(app, other);
  await clickMenu(app, 'choose-library');
  await expect.poll(() => currentDocument(page), { timeout: 15_000 }).toBe('there.md');
  expect(read(path.join(lib, 'here.md'))).toBe('here unsaved');
  await expect(page.locator('.cm-content')).toHaveText('there');
  const settings = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  expect(settings.libraryDir).toBe(other);
  expect(settings.lastDocument).toBe('there.md');
  // Writes now go to the new folder.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('!');
  await expect.poll(() => read(path.join(other, 'there.md'))).toBe('there!');
  // The renderer can't redirect the library through settings.
  await page.evaluate(() =>
    (window as unknown as { marginDesktop: { settings: { update(p: unknown): Promise<unknown> } } }).marginDesktop.settings.update({
      libraryDir: '/',
    }),
  );
  expect(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).libraryDir).toBe(other);
  await quitAndWait(app);
});
