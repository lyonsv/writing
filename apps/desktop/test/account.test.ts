import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Test-only cross-app import: the real server and a mock GitHub over real HTTP.
import { browse, startMockGitHub, startTestServer } from '../../server/test/mockGitHubHttp';
import { AccountManager, parseServerUrl, type SecretBox } from '../src/account';

const OWNER = { login: 'lyonsv', id: 1234567 };

/** Stand-in for safeStorage: reversible, but the plaintext never appears in the file. */
const box = (available = true): SecretBox => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64').split('').reverse().join('')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(7).split('').reverse().join(''), 'base64').toString(),
});

let github: Awaited<ReturnType<typeof startMockGitHub>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
let dir: string;
const opened: string[] = [];
const statuses: string[] = [];

function manager(opts: { serverUrl?: string; box?: SecretBox; browser?: (url: string) => Promise<void>; timeoutMs?: number } = {}) {
  return new AccountManager({
    file: path.join(dir, 'account', 'session.bin'),
    serverUrl: () => opts.serverUrl ?? server.url,
    openExternal:
      opts.browser ??
      (async (url) => {
        opened.push(url);
        // The "system browser" runs independently of the app.
        void browse(url).catch(() => undefined);
      }),
    secretBox: opts.box ?? box(),
    deviceName: () => 'Test Mac',
    onChange: (s) => statuses.push(s.state),
    signInTimeoutMs: opts.timeoutMs,
  });
}

beforeAll(async () => {
  github = await startMockGitHub(OWNER);
  server = await startTestServer(github, OWNER);
});
afterAll(async () => {
  await server.close();
  await github.close();
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'margin-account-'));
  opened.length = 0;
  statuses.length = 0;
  github.state.user = OWNER;
  github.state.deny = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('desktop sign-in round trip (loopback + PKCE) against a local server and mock GitHub', () => {
  it('signs in, stores the token encrypted, and lists this device', async () => {
    const m = manager();
    expect(m.status()).toEqual({ state: 'signed-out', serverUrl: server.url });
    const status = await m.signIn();
    expect(status).toMatchObject({ state: 'signed-in', login: 'lyonsv', serverUrl: server.url });
    expect(statuses).toContain('signing-in');

    // The browser was sent to the server's start URL with S256 PKCE and a loopback redirect.
    const start = new URL(opened[0]!);
    expect(start.origin + start.pathname).toBe(`${server.url}/api/auth/native/start`);
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const file = readFileSync(path.join(dir, 'account', 'session.bin'), 'utf8');
    expect(file.startsWith('SEALED:')).toBe(true);
    expect(file).not.toContain('mgn_');

    const devices = await m.listDevices();
    const current = devices.filter((d) => d.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ name: 'Test Mac', kind: 'native', id: (status as { deviceId: string }).deviceId });
    expect(JSON.stringify(devices)).not.toContain('mgn_');
  });

  it('persists across restarts, but only for the server it was issued by', async () => {
    await manager().signIn();
    const again = manager();
    await again.load();
    expect(again.status().state).toBe('signed-in');

    const elsewhere = manager({ serverUrl: 'https://other.example' });
    await elsewhere.load();
    expect(elsewhere.status().state).toBe('signed-out');
    await expect(elsewhere.listDevices()).rejects.toThrow('Not signed in');
  });

  it('never writes the token in plain text when OS encryption is unavailable', async () => {
    const m = manager({ box: box(false) });
    expect((await m.signIn()).state).toBe('signed-in');
    expect(existsSync(path.join(dir, 'account', 'session.bin'))).toBe(false);
  });

  it('revokes another device, and revoking itself signs out', async () => {
    const mac = manager();
    await mac.signIn();
    const phoneDir = mkdtempSync(path.join(tmpdir(), 'margin-account-'));
    const phone = new AccountManager({
      file: path.join(phoneDir, 'session.bin'),
      serverUrl: () => server.url,
      openExternal: async (u) => void browse(u),
      secretBox: box(),
      deviceName: () => 'Phone',
    });
    await phone.signIn();
    const phoneId = (phone.status() as { deviceId: string }).deviceId;

    await mac.revokeDevice(phoneId);
    const ids = (await mac.listDevices()).map((d) => d.id);
    expect(ids).not.toContain(phoneId);
    expect(ids).toContain((mac.status() as { deviceId: string }).deviceId);
    // The phone finds out on its next request.
    await expect(phone.listDevices()).rejects.toThrow('signed out');
    expect(phone.status()).toMatchObject({ state: 'signed-out', error: expect.stringContaining('revoked') });

    const self = (mac.status() as { deviceId: string }).deviceId;
    expect((await mac.revokeDevice(self)).state).toBe('signed-out');
    expect(existsSync(path.join(dir, 'account', 'session.bin'))).toBe(false);
    rmSync(phoneDir, { recursive: true, force: true });
  });

  it('sign out revokes the token on the server and forgets it locally', async () => {
    const m = manager();
    await m.signIn();
    let token = '';
    // Peek at the token the way only main could, to prove the server rejects it afterwards.
    const peek = manager();
    await peek.load();
    token = (peek as unknown as { session: { token: string } }).session.token;
    expect((await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await m.signOut()).state).toBe('signed-out');
    expect((await fetch(`${server.url}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(existsSync(path.join(dir, 'account', 'session.bin'))).toBe(false);
  });

  it('reports a non-allowlisted GitHub account without storing anything', async () => {
    github.state.user = { login: 'mallory', id: 666 };
    const m = manager();
    await expect(m.signIn()).rejects.toThrow(/isn’t allowed|cancelled/);
    expect(m.status()).toMatchObject({ state: 'signed-out', error: expect.any(String) });
    expect(existsSync(path.join(dir, 'account'))).toBe(false);
  });

  it('reports a cancelled GitHub consent', async () => {
    github.state.deny = true;
    await expect(manager().signIn()).rejects.toThrow(/cancelled/);
  });

  it('ignores loopback requests with the wrong state or path, then completes', async () => {
    const m = manager({
      browser: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        const forged = await fetch(`${redirect}?code=${'x'.repeat(43)}&state=forged`);
        expect(forged.status).toBe(400);
        expect((await fetch(redirect.replace('/callback', '/other'))).status).toBe(404);
        void browse(url);
      },
    });
    expect((await m.signIn()).state).toBe('signed-in');
  });

  it('times out if the browser never comes back, and a second Sign In restarts cleanly', async () => {
    const stuck = manager({ browser: async () => undefined, timeoutMs: 200 });
    await expect(stuck.signIn()).rejects.toThrow(/timed out/);
    expect(stuck.status().state).toBe('signed-out');

    // First attempt: the user closes the tab. Second attempt (same manager) completes.
    let calls = 0;
    const m = manager({
      timeoutMs: 60_000,
      browser: async (url) => {
        if (++calls > 1) void browse(url);
      },
    });
    const first = m.signIn();
    await new Promise((r) => setTimeout(r, 50));
    const second = m.signIn();
    await expect(first).rejects.toThrow(/restarted/);
    expect((await second).state).toBe('signed-in');
    expect(m.status().state).toBe('signed-in');
  });

  it('validates server URLs', () => {
    expect(parseServerUrl('https://margin.example.com/x')).toBe('https://margin.example.com');
    expect(parseServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => parseServerUrl('http://margin.example.com')).toThrow();
    expect(() => parseServerUrl('https://user:pw@margin.example.com')).toThrow();
    expect(() => parseServerUrl('file:///etc/passwd')).toThrow();
  });
});
