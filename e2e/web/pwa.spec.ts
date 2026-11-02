import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startMockGitHub, startTestServer } from '../../apps/server/test/mockGitHubHttp';
import { webDir } from '../../apps/server/src/webFiles';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The installable web app (ADR 0020) in WebKit with an iPhone 15 profile,
 * served by a local Margin server (in-memory store, mock GitHub) from the
 * built web export (`pnpm build:web`).
 */

const OWNER = { login: 'lyonsv', id: 1234567 };
const exportDir = path.resolve(import.meta.dirname, '../../apps/app/dist');

let github: Awaited<ReturnType<typeof startMockGitHub>>;
let server: Awaited<ReturnType<typeof startTestServer>>;

/** Lets a test make the server fail (5xx) or hang when it serves the app shell. */
let shellMode: 'ok' | 'error' | 'hang' = 'ok';

test.beforeEach(async () => {
  shellMode = 'ok';
  github = await startMockGitHub(OWNER);
  const files = webDir(exportDir);
  server = await startTestServer(github, OWNER, {}, {
    web: {
      ...files,
      shell: async () => {
        if (shellMode === 'error') throw new Error('simulated server failure');
        if (shellMode === 'hang') await new Promise((r) => setTimeout(r, 30_000));
        return files.shell();
      },
    },
  });
});
test.afterEach(async () => {
  await server.close();
  await github.close();
});

async function signIn(page: Page) {
  await page.goto(server.url);
  await expect(page.locator('#margin-signin')).toBeVisible();
  await page.locator('#margin-signin-link').click();
  // Mock GitHub approves; back on our origin with the session cookie: the app shell.
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
}

/** The editor's text. CodeMirror only renders lines near the viewport, so jump to the end first. */
async function editorText(page: Page): Promise<string> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.waitForTimeout(100);
  return page.locator('.cm-content').innerText();
}

async function typeAtEnd(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(text);
}

/** What the server has, as path → text, read with the page's own cookie session. */
async function serverDocs(page: Page): Promise<Record<string, string>> {
  const manifest = (await (await page.request.get(`${server.url}/api/sync/manifest`)).json()) as { entries: Array<{ path: string; deleted?: boolean }> };
  const out: Record<string, string> = {};
  for (const e of manifest.entries.filter((x) => !x.deleted)) {
    out[e.path] = await (await page.request.get(`${server.url}/api/sync/file?path=${encodeURIComponent(e.path)}`)).text();
  }
  return out;
}

const syncNow = (page: Page) =>
  page.evaluate(() => {
    // The app syncs whenever it becomes visible (visibilitychange), as on an iPhone returning to the app.
    document.dispatchEvent(new Event('visibilitychange'));
  });

test('signed out: the sign-in page, never the app; signing in opens the welcome document and syncs it', async ({ page }) => {
  await page.goto(`${server.url}/settings`);
  expect(await page.locator('#root').count()).toBe(0);
  await signIn(page);
  await expect(page.locator('.cm-content')).toContainText('Welcome to Margin');
  // Phone layout: the toolbar of the M6 editor screen, not the desktop sidebar.
  await expect(page.getByLabel('Back to the library')).toBeVisible();
  await typeAtEnd(page, '\nWritten on the phone.');
  await expect.poll(async () => (await serverDocs(page))['Welcome to Margin.md'] ?? '', { timeout: 20_000 }).toContain('Written on the phone.');
});

test('documents persist in IndexedDB across reloads, and edits made offline sync after reconnecting', async ({ page, context }) => {
  await signIn(page);
  await typeAtEnd(page, '\nfirst line');
  await expect.poll(async () => (await serverDocs(page))['Welcome to Margin.md'] ?? '', { timeout: 20_000 }).toContain('first line');

  await context.setOffline(true);
  await typeAtEnd(page, '\noffline line');
  await page.waitForTimeout(1500); // saved locally (debounce + IndexedDB)
  await page.reload().catch(() => undefined); // offline reload: the service worker's cached shell, if it has one
  await context.setOffline(false);
  await page.goto(server.url);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
  expect(await editorText(page)).toContain('offline line'); // survived the reload (IndexedDB)
  await syncNow(page);
  await expect.poll(async () => (await serverDocs(page))['Welcome to Margin.md'] ?? '', { timeout: 20_000 }).toContain('offline line');
});

test('the web app and the desktop client converge on the same server', async ({ page }) => {
  await signIn(page);
  // A desktop "device": the real desktop library + sync service on the same account (child process).
  const dir = mkdtempSync(path.join(tmpdir(), 'margin-pwa-mac-'));
  // Bundled with esbuild (the desktop's own bundler) so @margin/core's raw TS resolves as it does in the app.
  const bundle = path.join(dir, 'desktopDevice.mjs');
  execFileSync(path.resolve(import.meta.dirname, '../../apps/desktop/node_modules/.bin/esbuild'), [
    path.join(import.meta.dirname, 'desktopDevice.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    `--outfile=${bundle}`,
    '--log-level=error',
  ]);
  // Async: the test server runs in this process, so a blocking exec would deadlock it.
  const mac = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [bundle, server.url, dir, 'sync', ...args], { encoding: 'utf8' });
    return JSON.parse(stdout.trim().split('\n').pop()!) as { status: string; files: Record<string, string> };
  };
  try {
    expect((await mac('From the Mac.md', 'written on the Mac')).status).toBe('idle');
    await syncNow(page);
    await page.getByLabel('Back to the library').click();
    await expect(page.getByTestId('library-row:From the Mac.md')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('library-row:From the Mac.md').click();
    await expect.poll(() => editorText(page)).toContain('written on the Mac');
    await typeAtEnd(page, ' and edited on the phone');
    await expect.poll(async () => (await serverDocs(page))['From the Mac.md'] ?? '', { timeout: 20_000 }).toContain('edited on the phone');
    const after = await mac();
    expect(after.files['From the Mac.md']).toBe('written on the Mac and edited on the phone');
    // Both devices hold the same library as the server.
    expect(after.files).toEqual(await serverDocs(page));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the service worker never caches API responses, and never serves the app after sign-out', async ({ page, context }) => {
  await signIn(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null || navigator.serviceWorker === undefined, undefined, { timeout: 10_000 }).catch(() => undefined);
  await page.reload(); // now controlled: the shell goes into the cache
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
  await syncNow(page);
  await page.waitForTimeout(1000);
  const cached = await page.evaluate(async () => {
    if (typeof caches === 'undefined') return null;
    const urls: string[] = [];
    for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  test.skip(cached === null, 'no Cache Storage in this browser build');
  expect(cached!.filter((u) => u.startsWith('/api/'))).toEqual([]);
  const hasSW = await page.evaluate(() => navigator.serviceWorker?.controller != null);
  test.info().annotations.push({ type: 'service worker controlling the page', description: String(hasSW) });
  console.log(`[pwa] service worker controlling the page: ${hasSW}; cached: ${JSON.stringify(cached)}`);

  if (hasSW) {
    // Offline relaunch while signed in: the cached shell (and the library) still open.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
  }

  // Sign out from Settings: back to the sign-in page, and the cached shell is gone.
  await page.getByLabel('Back to the library').click();
  await page.getByLabel('Settings and account').click();
  await page.getByTestId('account-sign-out').click();
  await expect(page.locator('#margin-signin')).toBeVisible({ timeout: 20_000 });
  if (hasSW) {
    await context.setOffline(true);
    await page.reload().catch(() => undefined);
    await expect(page.getByTestId('editor')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(/online|sign in/i);
    await context.setOffline(false);
  }
  const after = await page.request.get(`${server.url}/api/me`);
  expect(after.status()).toBe(401);
});

test('two tabs: an edit in one reaches the other (BroadcastChannel), and saves and syncs share one lock (Web Locks)', async ({ page, context }) => {
  await signIn(page);
  const second = await context.newPage();
  await second.goto(server.url);
  await expect(second.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
  expect(await second.evaluate(() => typeof navigator.locks?.request === 'function' && typeof BroadcastChannel === 'function')).toBe(true);
  // Both tabs show the welcome document. Type in the second; the first (clean) reloads it.
  await typeAtEnd(second, '\nfrom the second tab');
  await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain('from the second tab');
  // Nothing was turned into a conflict copy, and the server ends up with the text.
  await syncNow(page);
  await expect.poll(async () => (await serverDocs(page))['Welcome to Margin.md'] ?? '', { timeout: 20_000 }).toContain('from the second tab');
  expect(Object.keys(await serverDocs(page)).filter((p) => p.includes('(conflict'))).toEqual([]);
  await second.close();
});

test('a revoked browser: next check routes to sign-in and the cached shell no longer opens offline; documents stay', async ({ page, context }) => {
  await signIn(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 10_000 }).catch(() => undefined);
  await page.reload();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
  await typeAtEnd(page, '\nkept after revoke');
  await page.waitForTimeout(1200);
  // Revoke this browser's device from "another device" (here: the API with this session).
  const me = (await (await page.request.get(`${server.url}/api/me`)).json()) as { device: { id: string } };
  expect((await page.request.delete(`${server.url}/api/devices/${me.device.id}`, { headers: { Origin: server.url } })).status()).toBe(204);
  await syncNow(page); // the app checks its session when it becomes visible
  await expect(page.locator('#margin-signin')).toBeVisible({ timeout: 20_000 });
  await context.setOffline(true);
  await page.reload().catch(() => undefined);
  await expect(page.getByTestId('editor')).toHaveCount(0);
  await context.setOffline(false);
  // Sign back in: the documents written before the revoke are still in this browser.
  await signIn(page);
  await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain('kept after revoke');
});

test('a failing or hung server never locks a signed-in user out: the cached shell opens (only 401/403 remove it)', async ({ page }) => {
  await signIn(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 10_000 });
  await page.reload();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });

  shellMode = 'error'; // the server answers 500
  await page.reload();
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });

  shellMode = 'hang'; // the server doesn't answer: after ~4 s the cached shell shows
  const started = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 20_000 });
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - started).toBeLessThan(15_000);

  shellMode = 'ok';
});
