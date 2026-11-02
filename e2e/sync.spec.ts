import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { browse, signInDevice, startMockGitHub, startTestServer } from '../apps/server/test/mockGitHubHttp';
import { clickMenu, currentDocument, launch, newLibrary, quitAndWait } from './launch';

/**
 * M5: the real Electron app syncing its library folder with a local server
 * (in-memory store) while a second "device" talks to the same server over HTTP.
 */
const OWNER = { login: 'lyonsv', id: 1234567 };

async function signInApp(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    (shell as unknown as Record<string, unknown>).openExternal = async (url: string) => void g.__opened.push(url);
  });
  await clickMenu(app, 'sign-in');
  let url: string | undefined;
  await expect
    .poll(async () => (url = (await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))[0]))
    .toBeTruthy();
  await browse(url!);
}

function phone(serverUrl: string, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const q = (p: string) => `${serverUrl}/api/sync/file?path=${encodeURIComponent(p)}`;
  return {
    manifest: async () =>
      ((await (await fetch(`${serverUrl}/api/sync/manifest`, { headers: auth })).json()) as { entries: Array<{ path: string; rev: string; deleted?: true }> })
        .entries.filter((e) => !e.deleted),
    text: async (p: string) => (await fetch(q(p), { headers: auth })).text(),
    put: (p: string, body: string, ifMatch?: string) =>
      fetch(q(p), { method: 'PUT', headers: { ...auth, ...(ifMatch ? { 'If-Match': `"${ifMatch}"` } : { 'If-None-Match': '*' }) }, body }),
  };
}

test('desktop sync: uploads disk and editor changes, downloads remote changes into the library and the open editor', async () => {
  test.setTimeout(120_000);
  const github = await startMockGitHub(OWNER);
  const server = await startTestServer(github, OWNER);
  const lib = newLibrary();
  writeFileSync(path.join(lib, 'from-disk.md'), 'written before sign-in');
  try {
    const app = await launch(lib, { MARGIN_SERVER_URL: server.url, MARGIN_SYNC_INTERVAL_MS: '600000' });
    const page = await app.firstWindow();
    await expect(page.locator('.cm-content')).toBeVisible();
    // Signed out: no sync status at all.
    await expect(page.getByTestId('sync-status')).toHaveCount(0);

    await signInApp(app);
    await expect(page.getByTestId('account-status')).toHaveText('Signed in as lyonsv');
    await page.getByTestId('account-close').click();
    // Signing in triggers a sync.
    await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 });

    const other = await signInDevice(server.url, 'Phone');
    const p = phone(server.url, other.token);
    await expect.poll(async () => (await p.manifest()).map((e) => e.path)).toContain('from-disk.md');
    expect(await p.text('from-disk.md')).toBe('written before sign-in');

    // Typing in the editor: Sync Now flushes the editor first, so the server gets what was typed.
    expect(await currentDocument(page)).toBe('from-disk.md');
    await page.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' + typed');
    await clickMenu(app, 'sync-now');
    await expect.poll(() => p.text('from-disk.md')).toBe('written before sign-in + typed');

    // The other device adds a document and edits the open one.
    await p.put('notes/from-phone.md', 'hello from the phone');
    const rev = (await p.manifest()).find((e) => e.path === 'from-disk.md')!.rev;
    expect((await p.put('from-disk.md', 'edited on the phone', rev)).status).toBe(200);
    await clickMenu(app, 'sync-now');
    await expect.poll(() => existsSync(path.join(lib, 'notes', 'from-phone.md'))).toBe(true);
    expect(readFileSync(path.join(lib, 'notes', 'from-phone.md'), 'utf8')).toBe('hello from the phone');
    // The open, clean editor reloads the downloaded text (ADR 0006 external change).
    await expect(page.locator('.cm-content')).toHaveText('edited on the phone');
    expect(readFileSync(path.join(lib, 'from-disk.md'), 'utf8')).toBe('edited on the phone');
    // And the sidebar shows the new file.
    await clickMenu(app, 'sidebar');
    await expect(page.getByTestId('library-row:notes')).toBeVisible();

    // Focus mode hides the sync status.
    await expect(page.getByTestId('sync-status')).toBeVisible();
    await clickMenu(app, 'focus-mode');
    await expect(page.getByTestId('sync-status')).toHaveCount(0);
    await clickMenu(app, 'focus-mode');

    // Signing out turns sync off (status disappears) and leaves the files alone.
    await clickMenu(app, 'sign-out');
    await expect(page.getByTestId('sync-status')).toHaveCount(0);
    expect(existsSync(path.join(lib, 'notes', 'from-phone.md'))).toBe(true);
    await quitAndWait(app);
  } finally {
    await server.close();
    await github.close();
  }
});
