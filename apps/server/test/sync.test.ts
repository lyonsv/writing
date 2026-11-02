import { createHash } from 'node:crypto';

import { isSyncablePath } from '@margin/core';
import { describe, expect, it } from 'vitest';

import { MAX_DOCUMENT_BYTES, SyncRepository } from '../src/sync';
import { isSyncPath } from '../src/syncPaths';
import { MemoryStore } from '../src/store';
import { bearer, setup, signIn } from './helpers';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function client() {
  const h = setup();
  const { token } = await signIn(h);
  const auth = bearer(token).headers;
  const q = (p: string) => `?path=${encodeURIComponent(p)}`;
  return {
    h,
    token,
    manifest: async () => (await (await h.req('/api/sync/manifest', { headers: auth })).json()) as { seq: number; entries: Array<{ path: string; rev: string; hash: string; deleted?: true }> },
    get: (p: string) => h.req(`/api/sync/file${q(p)}`, { headers: auth }),
    put: (p: string, body: string | Uint8Array, pre: Record<string, string>) =>
      h.req(`/api/sync/file${q(p)}`, { method: 'PUT', headers: { ...auth, ...pre }, body: body as unknown as BodyInit }),
    del: (p: string, rev?: string) => h.req(`/api/sync/file${q(p)}`, { method: 'DELETE', headers: { ...auth, ...(rev ? { 'If-Match': `"${rev}"` } : {}) } }),
    move: (from: string, to: string, ifMatch: string) =>
      h.req('/api/sync/move', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, ifMatch }) }),
  };
}
const created = { 'If-None-Match': '*' };
const rev = async (res: Response) => ((await res.json()) as { entry: { rev: string } }).entry.rev;

describe('sync API', () => {
  it('every sync route requires a token', async () => {
    const h = setup();
    for (const [method, path] of [
      ['GET', '/api/sync/manifest'],
      ['GET', '/api/sync/file?path=a.md'],
      ['PUT', '/api/sync/file?path=a.md'],
      ['DELETE', '/api/sync/file?path=a.md'],
      ['POST', '/api/sync/move'],
    ] as const) {
      expect((await h.req(path, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  it('create-only, conditional update, 412 with the current entry, 428 without a precondition', async () => {
    const c = await client();
    const r1 = await rev(await c.put('notes/a.md', 'one', created));
    expect((await c.put('notes/a.md', 'again', created)).status).toBe(412);
    expect((await c.put('notes/a.md', 'blind', {})).status).toBe(428);
    const r2 = await rev(await c.put('notes/a.md', 'two', { 'If-Match': `"${r1}"` }));
    const stale = await c.put('notes/a.md', 'stale', { 'If-Match': `"${r1}"` });
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { current: { rev: string; hash: string } }).current).toMatchObject({ rev: r2, hash: sha('two') });
    const got = await c.get('notes/a.md');
    expect(await got.text()).toBe('two');
    expect(got.headers.get('ETag')).toBe(`"${r2}"`);
    expect((await c.manifest()).entries).toEqual([expect.objectContaining({ path: 'notes/a.md', rev: r2, hash: sha('two'), size: 3 })]);
  });

  it('concurrent updates with the same If-Match: exactly one wins', async () => {
    const c = await client();
    const r1 = await rev(await c.put('a.md', 'base', created));
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => c.put('a.md', `v${i}`, { 'If-Match': `"${r1}"` })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 412, 412, 412, 412]);
    // Concurrent creates of different files all land (manifest CAS retries).
    const many = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => c.put(`f${i}.md`, `x${i}`, created)));
    expect(many.every((r) => r.status === 200)).toBe(true);
    expect((await c.manifest()).entries.filter((e) => !e.deleted)).toHaveLength(7);
  });

  it('deletes leave a tombstone with a new rev; re-creating is allowed; stale deletes are refused', async () => {
    const c = await client();
    const r1 = await rev(await c.put('a.md', 'x', created));
    expect((await c.del('a.md')).status).toBe(428);
    expect((await c.del('a.md', '999')).status).toBe(412);
    const tomb = (await (await c.del('a.md', r1)).json()) as { entry: { rev: string; deleted: boolean } };
    expect(tomb.entry.deleted).toBe(true);
    expect(Number(tomb.entry.rev)).toBeGreaterThan(Number(r1));
    expect((await c.get('a.md')).status).toBe(404);
    expect((await c.manifest()).entries).toEqual([expect.objectContaining({ path: 'a.md', deleted: true })]);
    expect((await c.put('a.md', 'x', { 'If-Match': `"${r1}"` })).status).toBe(412);
    const r3 = await rev(await c.put('a.md', 'back', created));
    expect(Number(r3)).toBeGreaterThan(Number(tomb.entry.rev));
  });

  it('moves atomically, including case-only renames, and never onto a live path', async () => {
    const c = await client();
    const r1 = await rev(await c.put('old.md', 'text', created));
    await c.put('taken.md', 'other', created);
    expect((await c.move('old.md', 'taken.md', r1)).status).toBe(412);
    expect((await c.move('old.md', 'new.md', '999')).status).toBe(412);
    const moved = await c.move('old.md', 'dir/new.md', r1);
    expect(moved.status).toBe(200);
    const m = await c.manifest();
    expect(m.entries.find((e) => e.path === 'old.md')).toMatchObject({ deleted: true });
    expect(m.entries.find((e) => e.path === 'dir/new.md')).toMatchObject({ hash: sha('text') });
    const r2 = await rev(moved);
    expect((await c.move('dir/new.md', 'dir/NEW.md', r2)).status).toBe(200);
    expect(await (await c.get('dir/NEW.md')).text()).toBe('text');
  });

  it('refuses paths that would collide on a case-insensitive disk or as file vs folder', async () => {
    const c = await client();
    await c.put('Notes/A.md', 'x', created);
    for (const p of ['notes/a.md', 'NOTES/A.md', 'Notes/A.md/x.md']) {
      const res = await c.put(p, 'y', created);
      expect(res.status, p).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'path_conflict', path: 'Notes/A.md' });
    }
    await c.put('folder.md/inner.md', 'x', created);
    expect((await c.put('folder.md', 'x', created)).status).toBe(409);
  });

  it('round-trips arbitrary bytes exactly (BOM, CRLF, not UTF-8)', async () => {
    const c = await client();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
    const r = await c.put('raw.md', bytes, created);
    expect(((await r.json()) as { entry: { hash: string } }).entry.hash).toBe(sha(bytes));
    const got = await c.get('raw.md');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const entry = JSON.parse(decodeURIComponent(got.headers.get('X-Margin-Entry')!)) as { hash: string };
    expect(entry.hash).toBe(sha(bytes));
  });

  it('refuses documents over 4 MiB with 413 and stores nothing', async () => {
    const c = await client();
    const res = await c.put('big.md', new Uint8Array(MAX_DOCUMENT_BYTES + 1), created);
    expect(res.status).toBe(413);
    expect((await c.manifest()).entries).toEqual([]);
    expect((await c.put('ok.md', new Uint8Array(MAX_DOCUMENT_BYTES), created)).status).toBe(200);
  });

  it('refuses invalid paths with 400', async () => {
    const c = await client();
    for (const p of ['a.txt', '.hidden.md', 'a/.git/x.md', '../a.md', '/a.md', 'a//b.md', 'a\\b.md', 'é.md', `${'x'.repeat(253)}.md`, 'a\n.md', '']) {
      expect((await c.put(p, 'x', created)).status, JSON.stringify(p)).toBe(400);
      expect((await c.get(p)).status, JSON.stringify(p)).toBe(400);
    }
    expect((await c.move('a.md', '../b.md', '1')).status).toBe(400);
  });

  it('serves the manifest with an ETag and 304 when unchanged', async () => {
    const c = await client();
    await c.put('a.md', 'x', created);
    const res = await c.h.req('/api/sync/manifest', bearer(c.token));
    const etag = res.headers.get('ETag')!;
    const again = await c.h.req('/api/sync/manifest', { headers: { ...bearer(c.token).headers, 'If-None-Match': etag } });
    expect(again.status).toBe(304);
  });

  it('keeps sync data out of the auth key space', async () => {
    const c = await client();
    await c.put('auth/devices/x.md', 'not an auth record', created);
    const keys = await c.h.store.list('');
    expect(keys.filter((k) => k.startsWith('auth/devices/') && k.includes('x.md'))).toEqual([]);
    expect(keys.some((k) => k.startsWith('sync/objects/'))).toBe(true);
  });
});

describe('server and core agree on what is syncable', () => {
  it('on a generated corpus', () => {
    const parts = ['a', 'B', '.', '..', '.h', 'é', 'é', '日', ' ', '\\', '\n', 'x'.repeat(250), ':', '#', '?', '%2e', ''];
    const exts = ['.md', '.MD', '.txt', ''];
    let n = 0;
    for (const a of parts) for (const b of parts) for (const ext of exts) {
      for (const p of [`${a}${ext}`, `${a}/${b}${ext}`, `/${a}${ext}`, `${a}//${b}${ext}`, `${a}/${b}/`]) {
        expect(isSyncPath(p), JSON.stringify(p)).toBe(isSyncablePath(p));
        n++;
      }
    }
    expect(n).toBeGreaterThan(5000);
  });
});

describe('SyncRepository', () => {
  it('prunes tombstones after 90 days', async () => {
    let t = 0;
    const repo = new SyncRepository(new MemoryStore(), () => t);
    const e = await repo.put('a.md', new TextEncoder().encode('x'), { ifNoneMatch: true });
    await repo.delete('a.md', e.rev);
    t += 91 * 24 * 60 * 60 * 1000;
    await repo.put('b.md', new TextEncoder().encode('y'), { ifNoneMatch: true });
    expect((await repo.manifest()).entries.map((x) => x.path)).toEqual(['b.md']);
  });
});
