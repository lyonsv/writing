import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Test-only cross-app imports: the real server + mock GitHub, and the desktop client.
import { browse, startMockGitHub, startTestServer } from '../../server/test/mockGitHubHttp';
import { AccountManager } from '../../desktop/src/account';
import { FileSystemLibrary } from '../../desktop/src/library';
import { SyncService } from '../../desktop/src/sync';
import { AccountError, NativeAccount, parseServerUrl, type SecretStore } from '../src/native/account';
import { NativeLibrary } from '../src/native/library';
import { NativeSyncService } from '../src/native/sync';
import { NodeFs } from './nodeFs';

const OWNER = { login: 'lyonsv', id: 1234567 };
let github: Awaited<ReturnType<typeof startMockGitHub>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
let base: string;

beforeAll(async () => {
  github = await startMockGitHub(OWNER);
});
afterAll(async () => {
  await github.close();
});
// A fresh server (empty store) per test.
beforeEach(async () => {
  server = await startTestServer(github, OWNER);
  base = mkdtempSync(path.join(tmpdir(), 'margin-ios-sync-'));
});
afterEach(async () => {
  await server.close();
  rmSync(base, { recursive: true, force: true });
});

class MemorySecrets implements SecretStore {
  map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}

/** Plays ASWebAuthenticationSession: follows the browser flow (pressing Continue) and returns the margin:// callback. */
async function authSession(url: string, redirect: string, decision: 'continue' | 'cancel' = 'continue') {
  const r = await browse(url, { stopAt: redirect, decision });
  return r.stoppedAt ? { type: 'success' as const, url: r.stoppedAt } : { type: 'cancel' as const };
}

function phone(name: string, opts: { serverUrl?: string; decision?: 'continue' | 'cancel'; net?: { up: boolean } } = {}) {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  const fs = new NodeFs(dir);
  const library = new NativeLibrary({ fs, now: () => new Date(2026, 10, 2, 12, 0) });
  const secrets = new MemorySecrets();
  const net = opts.net ?? { up: true };
  const sessions: string[] = [];
  const account = new NativeAccount({
    secrets,
    openAuthSession: (url, redirect) => {
      sessions.push(url);
      return authSession(url, redirect, opts.decision);
    },
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256: (b) => new Uint8Array(createHash('sha256').update(b).digest()),
    fetch: async (input, init) => {
      if (!net.up) throw new TypeError('Network request failed');
      return fetch(input, init);
    },
    serverUrl: () => opts.serverUrl ?? server.url,
    deviceName: () => name,
  });
  const sync = new NativeSyncService({ library, fs, account });
  const root = path.join(dir, 'Margin');
  const write = (p: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), text);
  };
  const read = (p: string) => (existsSync(path.join(root, p)) ? readFileSync(path.join(root, p), 'utf8') : null);
  return { name, dir, fs, library, account, secrets, sync, root, write, read, sessions, net };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    if (!existsSync(path.join(root, rel))) return;
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) out[p] = readFileSync(path.join(root, p), 'utf8');
    }
  };
  walk('');
  return out;
}

describe('iOS sign-in (margin://auth/callback through the confirmation page)', () => {
  it('signs in with PKCE, keeps the token only in the secret store, lists devices and signs out', async () => {
    const p = phone('iPhone');
    await p.library.init();
    expect((await p.account.status()).state).toBe('signed-out');
    const status = await p.account.signIn();
    expect(status).toMatchObject({ state: 'signed-in', login: 'lyonsv' });
    const start = new URL(p.sessions[0]!);
    expect(start.searchParams.get('redirect_uri')).toBe('margin://auth/callback');
    expect(start.searchParams.get('code_challenge_method')).toBe('S256');
    const stored = JSON.parse([...p.secrets.map.values()][0]!);
    expect(stored.token).toMatch(/^mgn_/);
    // Nothing token-like on disk.
    for (const f of readdirSync(p.dir, { recursive: true }).map(String)) {
      const full = path.join(p.dir, f);
      if (!readdirSync(path.dirname(full), { withFileTypes: true }).find((e) => e.name === path.basename(full))?.isFile()) continue;
      expect(readFileSync(full, 'utf8'), f).not.toContain('mgn_');
    }
    const devices = await p.account.listDevices();
    expect(devices.find((d) => d.current)?.name).toBe('iPhone');
    expect((await p.account.signOut()).state).toBe('signed-out');
    expect(p.secrets.map.size).toBe(0);
  });

  it('a cancelled confirmation page signs nothing in', async () => {
    const p = phone('iPhone', { decision: 'cancel' });
    await expect(p.account.signIn()).rejects.toThrow(AccountError);
    expect((await p.account.status()).state).toBe('signed-out');
    expect(p.secrets.map.size).toBe(0);
  });

  it('a callback with the wrong state is refused', async () => {
    const p = phone('iPhone');
    const account = new NativeAccount({
      ...(p.account as unknown as { deps: ConstructorParameters<typeof NativeAccount>[0] }).deps,
      openAuthSession: async (url, redirect) => {
        const r = await authSession(url, redirect);
        return { type: 'success', url: (r as { url: string }).url.replace(/state=[^&]+/, 'state=forged') };
      },
    });
    await expect(account.signIn()).rejects.toThrow(/not recognised/);
    expect((await account.status()).state).toBe('signed-out');
  });

  it('a revoked device is signed out on its next request and sync turns off', async () => {
    const a = phone('iPhone');
    const b = phone('Mac-ish');
    await a.library.init();
    await a.account.signIn();
    await b.account.signIn();
    const aId = (await a.account.status()) as { deviceId: string };
    await b.account.revokeDevice(aId.deviceId);
    expect((await a.sync.syncNow()).state).toBe('off');
    expect((await a.account.status()).state).toBe('signed-out');
    expect(a.secrets.map.size).toBe(0);
  });

  it('server URLs must be https (http only on loopback, or a private LAN address in development)', () => {
    expect(parseServerUrl('https://margin-sync.vercel.app/x')).toBe('https://margin-sync.vercel.app');
    expect(parseServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(() => parseServerUrl('http://example.com')).toThrow();
    expect(() => parseServerUrl('http://192.168.1.20:3000')).toThrow();
    expect(parseServerUrl('http://192.168.1.20:3000', true)).toBe('http://192.168.1.20:3000');
    expect(() => parseServerUrl('https://user:pw@example.com')).toThrow();
  });

  it('never sends the token to a different server after the URL setting changes', async () => {
    let url = server.url;
    const p = phone('iPhone');
    const account = new NativeAccount({ ...(p.account as unknown as { deps: ConstructorParameters<typeof NativeAccount>[0] }).deps, serverUrl: () => url });
    await account.signIn();
    url = 'https://other.example';
    expect((await account.status()).state).toBe('signed-out');
    await expect(account.request('GET', '/api/me')).rejects.toThrow(/Not signed in/);
  });
});

describe('iOS sync against the real server', () => {
  it('two iPhones converge; conflicts keep both; deletes go to Recently Deleted', async () => {
    const a = phone('A');
    const b = phone('B');
    for (const d of [a, b]) {
      await d.library.init();
      await d.account.signIn();
    }
    a.write('notes/one.md', 'from A');
    b.write('two.md', 'from B');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect((await a.sync.syncNow()).state).toBe('idle');
    expect(snapshot(a.root)).toEqual({ 'notes/one.md': 'from A', 'two.md': 'from B' });
    expect(snapshot(b.root)).toEqual(snapshot(a.root));

    // Both edit the same document offline-ish: both versions survive.
    a.write('two.md', 'A edit');
    b.write('two.md', 'B edit');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(b.sync.lastReport!.conflicts).toEqual(['two.md']);
    expect(snapshot(a.root)).toEqual(snapshot(b.root));
    expect(Object.values(snapshot(a.root)).sort()).toEqual(['A edit', 'B edit', 'from A']);

    // A deletes; B's copy goes to Recently Deleted, not oblivion.
    await a.library.delete('notes/one.md');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.read('notes/one.md')).toBeNull();
    expect((await b.library.listTrash()).map((t) => t.originalPath)).toContain('notes/one.md');

    // Renames sync as moves.
    await a.library.rename('two.md', 'renamed.md');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.read('renamed.md')).toBe('A edit'); // B's own edit went to its conflict copy
    expect(b.read('two.md')).toBeNull();
  });

  it('a download into the open document reaches the editor; a dirty editor saves to a conflict copy', async () => {
    const a = phone('A');
    const b = phone('B');
    for (const d of [a, b]) {
      await d.library.init();
      await d.account.signIn();
    }
    await b.library.open('doc.md');
    await b.library.save('doc.md', 'v1');
    await b.sync.syncNow();
    await a.sync.syncNow();
    a.write('doc.md', 'v2 from A');
    await a.sync.syncNow();
    const changes: string[] = [];
    b.library.onExternalChange((c) => changes.push(c.content));
    await b.sync.syncNow();
    await b.library.idle();
    expect(changes).toEqual(['v2 from A']);
    // The editor still had "v1 + typing" unsaved:
    const r = await b.library.save('doc.md', 'v1 + typing');
    expect(r.status).toBe('conflict');
    expect(b.read('doc.md')).toBe('v2 from A');
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(Object.values(snapshot(a.root)).sort()).toEqual(['v1 + typing', 'v2 from A']);
  });

  it('offline: status says so, nothing changes, and it catches up later', async () => {
    const net = { up: true };
    const a = phone('A', { net });
    await a.library.init();
    await a.account.signIn();
    net.up = false;
    a.write('x.md', 'offline text');
    expect((await a.sync.syncNow()).state).toBe('offline');
    expect(a.read('x.md')).toBe('offline text');
    net.up = true;
    expect((await a.sync.syncNow()).state).toBe('idle');
    expect(a.sync.lastReport!.uploaded).toEqual(['x.md']);
  });

  it('an iPhone and a Mac (desktop client) converge on the same server', async () => {
    const p = phone('iPhone');
    await p.library.init();
    await p.account.signIn();
    const macDir = path.join(base, 'mac');
    const mac = new FileSystemLibrary(path.join(macDir, 'library'));
    await mac.init();
    const account = new AccountManager({
      file: path.join(macDir, 'session.bin'),
      serverUrl: () => server.url,
      openExternal: async (u) => void browse(u),
      secretBox: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
      deviceName: () => 'Mac',
    });
    await account.signIn();
    const macSync = new SyncService({
      library: () => mac,
      account,
      stateDir: path.join(macDir, 'sync'),
      trash: async (abs) => rmSync(abs),
    });
    p.write('from-phone.md', 'written on the iPhone ✍️');
    mkdirSync(path.join(macDir, 'library', 'Mac notes'), { recursive: true });
    writeFileSync(path.join(macDir, 'library', 'Mac notes', 'é.md'), '﻿written on the Mac\r\n');
    await p.sync.syncNow();
    await macSync.syncNow();
    await p.sync.syncNow();
    expect(snapshot(p.root)).toEqual(snapshot(path.join(macDir, 'library')));
    expect(p.read('Mac notes/é.md')).toBe('﻿written on the Mac\r\n'); // byte-exact (BOM, CRLF)
    expect(readFileSync(path.join(macDir, 'library', 'from-phone.md'), 'utf8')).toBe('written on the iPhone ✍️');
  });

  it('reset sync state never deletes text and keeps differing versions as conflict copies', async () => {
    const a = phone('A');
    await a.library.init();
    await a.account.signIn();
    a.write('a.md', 'one');
    await a.sync.syncNow();
    a.write('a.md', 'local only edit');
    // Lose the base, as after a rollback recovery.
    const report = await a.sync.resetBase();
    expect(report.state).toBe('idle');
    // The server's version keeps the name; this device's differing text is a conflict copy.
    expect(a.read('a.md')).toBe('one');
    expect(a.read('a (conflict 2026-11-02 1200).md')).toBe('local only edit');
  });
});
