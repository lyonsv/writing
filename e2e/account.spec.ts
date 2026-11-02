import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { browse, signInDevice, startMockGitHub, startTestServer } from '../apps/server/test/mockGitHubHttp';
import { clickMenu, launch, newLibrary, newUserData, quitAndWait } from './launch';

/**
 * M4 round trip: the real Electron app signs in against a local Margin server
 * (in-memory store) and a mock GitHub, over real HTTP and a real loopback
 * redirect. Playwright can't drive the system browser, so `shell.openExternal`
 * is stubbed in main and the test follows the redirects itself (`browse`).
 */
const OWNER = { login: 'lyonsv', id: 1234567 };

async function stubBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    (shell as unknown as Record<string, unknown>).openExternal = async (url: string) => void g.__opened.push(url);
  });
}

const openedUrls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []);

const menuState = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()!;
    return { signIn: m.getMenuItemById('sign-in')!.enabled, signOut: m.getMenuItemById('sign-out')!.enabled };
  });

test('desktop sign-in round trip, device list and revoke, token never in the renderer, sign out', async () => {
  test.setTimeout(90_000);
  const github = await startMockGitHub(OWNER);
  const server = await startTestServer(github, OWNER);
  const lib = newLibrary();
  const userData = newUserData();
  try {
    let app = await launch(lib, { MARGIN_SERVER_URL: server.url }, userData);
    let page = await app.firstWindow();
    await expect(page.locator('.cm-content')).toBeVisible();
    await stubBrowser(app);

    // Signed out by default; the menu reflects it.
    expect(await menuState(app)).toEqual({ signIn: true, signOut: false });
    await clickMenu(app, 'account');
    await expect(page.getByTestId('account-status')).toHaveText('Not signed in');
    await page.getByTestId('account-close').click();

    // Sign In… opens the panel and the system browser at the server's start URL.
    await clickMenu(app, 'sign-in');
    await expect(page.getByTestId('account-status')).toHaveText('Waiting for your browser…');
    await expect.poll(() => openedUrls(app)).toHaveLength(1);
    const [startUrl] = await openedUrls(app);
    expect(startUrl).toMatch(new RegExp(`^${server.url}/api/auth/native/start\\?`));
    const start = new URL(startUrl!);
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The "browser": server → GitHub (approves) → server callback → the app's loopback listener.
    const result = await browse(startUrl!);
    expect(result.visited.map((u) => new URL(u).origin)).toEqual([
      server.url,
      github.url,
      server.url,
      new URL(start.searchParams.get('redirect_uri')!).origin,
    ]);
    expect(result.text).toContain('Signed in to Margin');

    await expect(page.getByTestId('account-status')).toHaveText('Signed in as lyonsv');
    await expect(page.locator('[data-testid^="account-device:"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="account-device:"]')).toContainText('this device');
    expect(await menuState(app)).toEqual({ signIn: false, signOut: true });

    // The token never reaches the renderer: the bridge exposes only status/devices.
    const seen = await page.evaluate(async () => {
      const a = (window as unknown as { marginDesktop: { account: Record<string, (...x: unknown[]) => Promise<unknown>> } }).marginDesktop.account;
      return { keys: Object.keys(a).sort(), status: JSON.stringify(await a.status!()), devices: JSON.stringify(await a.listDevices!()) };
    });
    expect(seen.keys).toEqual(['listDevices', 'onChange', 'revokeDevice', 'signIn', 'signOut', 'status']);
    expect(seen.status + seen.devices).not.toContain('mgn_');
    expect(await page.content()).not.toContain('mgn_');
    // Stored encrypted (safeStorage) in userData.
    const sessionFile = path.join(userData, 'account', 'session.bin');
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile).toString('latin1')).not.toContain('mgn_');

    // A second device appears; revoke it from the panel (two clicks: Revoke, Confirm).
    const phone = await signInDevice(server.url, 'Phone');
    await page.getByTestId('account-close').click();
    await clickMenu(app, 'account');
    await expect(page.locator('[data-testid^="account-device:"]')).toHaveCount(2);
    await page.getByTestId(`account-revoke:${phone.id}`).click();
    await expect(page.getByTestId(`account-revoke:${phone.id}`)).toHaveText('Confirm');
    await page.getByTestId(`account-revoke:${phone.id}`).click();
    await expect(page.locator('[data-testid^="account-device:"]')).toHaveCount(1);
    expect((await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${phone.token}` } })).status).toBe(401);

    // Persists across a restart.
    await quitAndWait(app);
    app = await launch(lib, { MARGIN_SERVER_URL: server.url }, userData);
    page = await app.firstWindow();
    await expect(page.locator('.cm-content')).toBeVisible();
    expect(await menuState(app)).toEqual({ signIn: false, signOut: true });
    await clickMenu(app, 'account');
    await expect(page.getByTestId('account-status')).toHaveText('Signed in as lyonsv');

    // Sign Out revokes on the server and forgets the token.
    await clickMenu(app, 'sign-out');
    await expect(page.getByTestId('account-status')).toHaveText('Not signed in');
    expect(existsSync(sessionFile)).toBe(false);
    const live = [];
    for (const key of await server.store.list('auth/devices/')) {
      const rec = JSON.parse((await server.store.get(key))!.value) as { revokedAt?: number };
      if (rec.revokedAt === undefined) live.push(key);
    }
    expect(live).toEqual([]);
    await quitAndWait(app);
  } finally {
    await server.close();
    await github.close();
  }
});

test('works fully offline and signed out: no server needed, a pending sign-in never blocks writing or quitting', async () => {
  const lib = newLibrary();
  // Nothing listens on this port.
  const app = await launch(lib, { MARGIN_SERVER_URL: 'http://127.0.0.1:9' });
  const page = await app.firstWindow();
  await expect(page.locator('.cm-content')).toBeVisible();
  await stubBrowser(app);
  await page.locator('.cm-content').click();
  await page.keyboard.type('offline words');
  await clickMenu(app, 'sign-in');
  await expect.poll(() => openedUrls(app)).toHaveLength(1);
  // The browser can't reach the server. Restarting opens a fresh attempt (the old one is
  // cancelled quietly); closing the panel leaves it pending, and the app stays fully usable.
  await expect(page.getByTestId('account-sign-in')).toHaveText('Restart Sign In…');
  await page.getByTestId('account-sign-in').click();
  await expect.poll(() => openedUrls(app)).toHaveLength(2);
  await expect(page.getByTestId('account-status')).toHaveText('Waiting for your browser…');
  await page.getByTestId('account-close').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type(' more');
  await quitAndWait(app);
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(lib).filter((f) => f.endsWith('.md'));
  expect(files).toHaveLength(1);
  expect(readFileSync(path.join(lib, files[0]!), 'utf8')).toContain('offline words more');
});
