import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExternalChange } from '@margin/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Test-only cross-app import: the real server and a mock GitHub over real HTTP.
import { browse, startMockGitHub, startTestServer } from '../../server/test/mockGitHubHttp';
import { AccountManager, type SecretBox } from '../src/account';
import { FileSystemLibrary } from '../src/library';
import { SyncService } from '../src/sync';

const OWNER = { login: 'lyonsv', id: 1234567 };
const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(s),
  decrypt: (b) => b.toString(),
};

let github: Awaited<ReturnType<typeof startMockGitHub>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
let base: string;

interface Device {
  name: string;
  root: string;
  library: FileSystemLibrary;
  account: AccountManager;
  sync: SyncService;
  trashed: string[];
  external: ExternalChange[];
  /** Simulated network: when false every request fails like an unreachable server. */
  net: { up: boolean };
}

async function device(name: string, serverUrl = server.url): Promise<Device> {
  const dir = path.join(base, name);
  const root = path.join(dir, 'library');
  const trashDir = path.join(dir, 'trash');
  mkdirSync(trashDir, { recursive: true });
  const external: ExternalChange[] = [];
  const library = new FileSystemLibrary(root, { now: () => new Date(2026, 10, 2, 12, 0), onExternalChange: (c) => external.push(c) });
  await library.init();
  const net = { up: true };
  const account = new AccountManager({
    file: path.join(dir, 'session.bin'),
    fetch: async (input, init) => {
      if (!net.up) throw new TypeError('fetch failed');
      return fetch(input, init);
    },
    serverUrl: () => serverUrl,
    openExternal: async (u) => void browse(u),
    secretBox: box,
    deviceName: () => name,
  });
  if (serverUrl === server.url) await account.signIn();
  const trashed: string[] = [];
  const sync = new SyncService({
    library: () => library,
    account,
    stateDir: path.join(dir, 'sync'),
    trash: async (abs) => {
      trashed.push(path.relative(root, abs));
      renameSync(abs, path.join(trashDir, `${trashed.length}-${path.basename(abs)}`));
    },
  });
  return { name, root, library, account, sync, trashed, external, net };
}

const write = (d: Device, p: string, text: string) => {
  mkdirSync(path.dirname(path.join(d.root, p)), { recursive: true });
  writeFileSync(path.join(d.root, p), text);
};
const read = (d: Device, p: string) => (existsSync(path.join(d.root, p)) ? readFileSync(path.join(d.root, p), 'utf8') : null);

/** path → text for every .md in the library. */
function snapshot(d: Device): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(d.root, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) out[p] = readFileSync(path.join(d.root, p), 'utf8');
    }
  };
  walk('');
  return out;
}

async function converge(...ds: Device[]) {
  for (let i = 0; i < 3; i++) for (const d of ds) await d.sync.syncNow();
  for (const d of ds) expect(d.sync.status().state, d.name).toBe('idle');
  const first = snapshot(ds[0]!);
  for (const d of ds.slice(1)) expect(snapshot(d), `${d.name} vs ${ds[0]!.name}`).toEqual(first);
  return first;
}

beforeAll(async () => {
  github = await startMockGitHub(OWNER);
});
afterAll(async () => {
  await github.close();
});
beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'margin-sync-'));
  server = await startTestServer(github, OWNER); // fresh, empty store per test
});
afterEach(async () => {
  await server.close();
  rmSync(base, { recursive: true, force: true });
});

describe('two desktop clients against the local server', () => {
  it('different files and the same file edited on both: converge, both texts kept', async () => {
    const a = await device('A');
    const b = await device('B');
    write(a, 'shared.md', 'v0');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(read(b, 'shared.md')).toBe('v0');

    write(a, 'shared.md', 'from A');
    write(a, 'notes/a-only.md', 'A');
    write(b, 'shared.md', 'from B');
    write(b, 'b-only.md', 'B');
    await a.sync.syncNow();
    await b.sync.syncNow();
    const final = await converge(a, b);
    expect(final).toEqual({
      'shared.md': 'from A',
      'shared (conflict 2026-11-02 1200).md': 'from B',
      'notes/a-only.md': 'A',
      'b-only.md': 'B',
    });
  });

  it('offline edits on both sides merge when back online; an unreachable server changes nothing', async () => {
    const a = await device('A');
    const b = await device('B');
    write(a, 'one.md', '1');
    await converge(a, b);

    // A loses the network and keeps writing; sync reports offline and touches nothing.
    a.net.up = false;
    write(a, 'one.md', '1 edited offline');
    write(a, 'new-offline.md', 'n');
    await a.sync.syncNow();
    expect(a.sync.status()).toMatchObject({ state: 'offline' });
    expect(snapshot(a)).toEqual({ 'one.md': '1 edited offline', 'new-offline.md': 'n' });
    expect(a.account.status().state).toBe('signed-in'); // offline is not signed out

    write(b, 'two.md', '2');
    await b.sync.syncNow();
    a.net.up = true;
    const final = await converge(a, b);
    expect(final).toEqual({ 'one.md': '1 edited offline', 'new-offline.md': 'n', 'two.md': '2' });
  });

  it('delete vs edit: the edit wins on both sides; plain deletes go to the Trash', async () => {
    const a = await device('A');
    const b = await device('B');
    write(a, 'contested.md', 'v0');
    write(a, 'doomed.md', 'bye');
    await converge(a, b);

    unlinkSync(path.join(a.root, 'contested.md'));
    write(b, 'contested.md', 'edited on B');
    unlinkSync(path.join(a.root, 'doomed.md'));
    await a.sync.syncNow();
    await b.sync.syncNow();
    const final = await converge(a, b);
    expect(final).toEqual({ 'contested.md': 'edited on B' });
    expect(b.trashed).toEqual(['doomed.md']); // B's copy of the deleted doc went to the Trash
  });

  it('renames propagate as renames (the same file moves, nothing is re-created)', async () => {
    const a = await device('A');
    const b = await device('B');
    write(a, 'draft.md', 'text');
    await converge(a, b);
    mkdirSync(path.join(a.root, 'final'));
    renameSync(path.join(a.root, 'draft.md'), path.join(a.root, 'final', 'chapter.md'));
    await a.sync.syncNow();
    expect(a.sync.lastReport?.moved).toEqual(['draft.md → final/chapter.md']);
    await b.sync.syncNow();
    expect(b.sync.lastReport?.moved).toEqual(['draft.md → final/chapter.md']);
    expect(b.trashed).toEqual([]);
    expect(await converge(a, b)).toEqual({ 'final/chapter.md': 'text' });
  });

  it('a download into a document open with unsaved text never loses that text (ADR 0006 path)', async () => {
    const a = await device('A');
    const b = await device('B');
    write(a, 'open.md', 'v0');
    await converge(a, b);

    // B has the document open in the editor (tracked).
    await b.library.open('open.md');
    write(a, 'open.md', 'remote edit');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(read(b, 'open.md')).toBe('remote edit');
    // The editor is told (external change), not silently bypassed…
    await expect.poll(() => b.external.map((c) => c.content)).toContain('remote edit');
    // …and if it saves its stale text instead of reloading, that goes to a conflict copy.
    const result = await b.library.save('open.md', 'v0 plus unsaved typing');
    expect(result.status).toBe('conflict');
    expect(read(b, 'open.md')).toBe('remote edit');
    const final = await converge(a, b);
    expect(Object.values(final).sort()).toEqual(['remote edit', 'v0 plus unsaved typing']);
  });

  it('a server restored from an older backup changes nothing locally and shows a sync error', async () => {
    const a = await device('A');
    write(a, 'early.md', 'v1');
    await a.sync.syncNow();
    const backup = (await server.store.get('sync/manifest.json'))!.value;
    write(a, 'early.md', 'v2');
    write(a, 'late.md', 'written after the backup');
    await a.sync.syncNow();
    await server.store.put('sync/manifest.json', backup); // the rollback
    const before = snapshot(a);
    await a.sync.syncNow();
    expect(snapshot(a)).toEqual(before);
    expect(a.trashed).toEqual([]);
    expect(a.sync.status()).toMatchObject({ state: 'error', message: expect.stringContaining('older') });
  });

  it('keeps going past documents the server refuses, and reports them', async () => {
    const a = await device('A');
    write(a, 'big.md', 'x'.repeat(4 * 1024 * 1024 + 10));
    write(a, 'ok.md', 'ok');
    await a.sync.syncNow();
    expect(a.sync.status()).toMatchObject({ state: 'idle', message: expect.stringContaining('not synced') });
    const b = await device('B');
    await b.sync.syncNow();
    expect(snapshot(b)).toEqual({ 'ok.md': 'ok' });
    expect(read(a, 'big.md')).toHaveLength(4 * 1024 * 1024 + 10);
  });

  it('persists the base per library and account; a revoked device stops syncing and keeps its files', async () => {
    const a = await device('A');
    write(a, 'keep.md', 'k');
    await a.sync.syncNow();
    const files = readdirSync(path.join(base, 'A', 'sync'));
    expect(files).toHaveLength(1);
    const state = JSON.parse(readFileSync(path.join(base, 'A', 'sync', files[0]!), 'utf8')) as { base: Record<string, unknown>; root: string };
    expect(Object.keys(state.base)).toEqual(['keep.md']);
    expect(state.root).toBe(a.root);
    expect(JSON.stringify(state)).not.toContain('mgn_');

    const b = await device('B');
    await b.account.revokeDevice((a.account.status() as { deviceId: string }).deviceId);
    write(a, 'after.md', 'local only');
    await a.sync.syncNow();
    expect(a.sync.status().state).toBe('off');
    expect(snapshot(a)).toEqual({ 'keep.md': 'k', 'after.md': 'local only' });
  });
});
