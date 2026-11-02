/**
 * Real-Blob verification (`pnpm --filter @margin/server verify:blob`). NOT part
 * of `pnpm test`: it talks to the real private Vercel Blob store connected to
 * the `margin-sync` project.
 *
 * 1. Pulls the project's Preview env vars into apps/server/.env.blob.local
 *    (git-ignored by `.env*`) with the Vercel CLI, unless BLOB_READ_WRITE_TOKEN
 *    is already set. Values are never printed.
 * 2. Runs every storage assumption ADRs 0012/0013 rely on against a throwaway
 *    prefix `verify-<random>/`, through our own BlobStore where possible.
 * 3. Deletes everything under that prefix, whatever happened.
 *
 * Prints PASS/FAIL per assumption with what was observed; exits 1 on any FAIL.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob';

import { BlobStore } from '../src/blobStore';
import { PreconditionFailedError } from '../src/store';
import { SyncConflictError, SyncRepository } from '../src/sync';

const serverDir = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(serverDir, '../..');
const envFile = path.join(serverDir, '.env.blob.local');

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  if (!existsSync(envFile)) {
    execFileSync('npx', ['-y', 'vercel@latest', 'env', 'pull', envFile, '--environment=preview', '--yes'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
  process.loadEnvFile(envFile);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('No BLOB_READ_WRITE_TOKEN (is the store connected to margin-sync for Preview?)');
  process.exit(2);
}

const prefix = `verify-${randomBytes(6).toString('hex')}/`;
const store = new BlobStore();
const results: Array<{ check: string; ok: boolean; observed: string }> = [];
const record = (check: string, ok: boolean, observed: string) => {
  results.push({ check, ok, observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}\n      ${observed}`);
};
const errName = (e: unknown) => (e instanceof Error ? `${e.constructor.name}${e.message ? `: ${e.message.slice(0, 120)}` : ''}` : String(e));
const settle = async <T>(ps: Array<Promise<T>>) => Promise.allSettled(ps);

async function main() {
  // 1. Concurrent conditional writes on one key: exactly one winner.
  {
    const k = `${prefix}manifest.json`;
    const { etag } = await store.put(k, JSON.stringify({ n: 0 }), { create: true });
    const outcomes = await settle(Array.from({ length: 10 }, (_, i) => store.put(k, JSON.stringify({ n: i + 1 }), { ifMatch: etag })));
    const wins = outcomes.filter((o) => o.status === 'fulfilled').length;
    const preconds = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof PreconditionFailedError).length;
    const other = outcomes.filter((o) => o.status === 'rejected' && !(o.reason instanceof PreconditionFailedError)).map((o) => errName((o as PromiseRejectedResult).reason));
    record('10 concurrent ifMatch puts → exactly one winner, the rest precondition-failed', wins === 1 && preconds === 9, `winners=${wins} precondition=${preconds} other=${JSON.stringify(other)}`);
    const after = await store.get(k);
    const winner = outcomes.findIndex((o) => o.status === 'fulfilled') + 1;
    record('the stored value is the winner’s', after?.value === JSON.stringify({ n: winner }), `stored=${after?.value}`);
  }

  // 2. Stale ifMatch after a successful write.
  {
    const k = `${prefix}stale.json`;
    const a = await store.put(k, '"a"', { create: true });
    const b = await store.put(k, '"b"', { ifMatch: a.etag });
    let staleErr: unknown = null;
    await store.put(k, '"c"', { ifMatch: a.etag }).catch((e: unknown) => (staleErr = e));
    record('a stale ifMatch is refused with PreconditionFailedError', staleErr instanceof PreconditionFailedError, `etag a=${a.etag} b=${b.etag} error=${errName(staleErr)}`);
    const same = await store.put(k, '"b"', { ifMatch: b.etag });
    // ETags are content-derived. Our CAS users never let a key return to an earlier value,
    // and MemoryStore models this (ADR 0012 amendments).
    record('ETags are content-derived (identical rewrite → same ETag), as MemoryStore models', same.etag === b.etag, `before=${b.etag} after=${same.etag}`);
  }

  // 2b. Larger JSON: get() may return a weak ETag; BlobStore must still win CAS with it.
  {
    const k = `${prefix}large.json`;
    const big = JSON.stringify({ entries: Array.from({ length: 400 }, (_, i) => ({ path: `notes/document-${i}.md`, rev: i, hash: 'f'.repeat(64) })) });
    await store.put(k, big, { create: true });
    const raw = await get(k, { access: 'private', useCache: false });
    const rawEtag = raw?.statusCode === 200 ? raw.blob.etag : 'none';
    if (raw?.statusCode === 200) await new Response(raw.stream).text();
    const read = await store.get(k);
    let ok = true;
    let err = '';
    await store.put(k, big.replace('"rev":0', '"rev":-1'), { ifMatch: read!.etag }).catch((e: unknown) => ((ok = false), (err = errName(e))));
    record(
      `${big.length}-byte JSON: CAS with the ETag BlobStore.get() returns succeeds`,
      ok,
      `raw get() ETag=${rawEtag} (weak=${rawEtag.startsWith('W/')}); BlobStore ETag=${read!.etag}${err ? `; error=${err}` : ''}`,
    );
  }

  // 3. Create-only semantics (allowOverwrite: false). Blob has no If-None-Match on put.
  {
    const k = `${prefix}create.json`;
    await store.put(k, '"first"', { create: true });
    let raw: unknown = null;
    await put(k, '"second"', { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' }).catch((e: unknown) => (raw = e));
    let mapped: unknown = null;
    await store.put(k, '"second"', { create: true }).catch((e: unknown) => (mapped = e));
    const kept = (await store.get(k))?.value;
    record('create-only on an existing key fails and leaves it untouched', raw !== null && kept === '"first"', `raw SDK error=${errName(raw)}; kept=${kept}`);
    record('BlobStore maps that failure to PreconditionFailedError (code retries on it)', mapped instanceof PreconditionFailedError, `BlobStore error=${errName(mapped)}`);

    const k2 = `${prefix}race-create.json`;
    const outcomes = await settle(Array.from({ length: 10 }, (_, i) => store.put(k2, JSON.stringify(i), { create: true })));
    const wins = outcomes.filter((o) => o.status === 'fulfilled').length;
    const kinds = outcomes.filter((o) => o.status === 'rejected').map((o) => ((o as PromiseRejectedResult).reason instanceof PreconditionFailedError ? 'precondition' : errName((o as PromiseRejectedResult).reason)));
    record('10 concurrent create-only puts → exactly one winner', wins === 1 && kinds.every((x) => x === 'precondition'), `winners=${wins} losers=${JSON.stringify(kinds)}`);
  }

  // 4. useCache:false reads see the latest write immediately.
  {
    const k = `${prefix}fresh.json`;
    let { etag } = await store.put(k, '0', { create: true });
    let fresh = 0;
    const lat: number[] = [];
    for (let i = 1; i <= 10; i++) {
      ({ etag } = await store.put(k, String(i), { ifMatch: etag }));
      const t = Date.now();
      const got = await store.get(k);
      lat.push(Date.now() - t);
      if (got?.value === String(i) && got.etag === etag) fresh++;
    }
    record('useCache:false read right after each overwrite returns it (10/10)', fresh === 10, `fresh=${fresh}/10, read latency ms=${JSON.stringify(lat)}`);
    // Contrast (informational): the default cached read.
    await store.put(k, 'cached-probe', { ifMatch: etag });
    const cached = await get(k, { access: 'private' });
    const cachedText = cached?.statusCode === 200 ? await new Response(cached.stream).text() : `status ${cached?.statusCode}`;
    record('(info) default cached read after overwrite', true, `returned ${JSON.stringify(cachedText)} (expected latest "cached-probe"; a stale value here is why the code uses useCache:false)`);
  }

  // 5. Private reads need the token.
  {
    const k = `${prefix}private.md`;
    const r = await put(k, 'secret text', { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/markdown' });
    const anon = await fetch(r.url);
    const anonDl = await fetch(r.downloadUrl);
    const anonBody = await anon.text();
    record(
      'the blob URL without credentials does not serve the content',
      anon.status >= 400 && !anonBody.includes('secret text') && anonDl.status >= 400,
      `url → HTTP ${anon.status}; downloadUrl → HTTP ${anonDl.status}`,
    );
    let bad: unknown = null;
    const wrong = await get(k, { access: 'private', token: 'vercel_blob_rw_invalid_token', useCache: false }).catch((e: unknown) => (bad = e));
    record('get() with a wrong token fails', bad !== null || wrong === null, `error=${errName(bad)} result=${wrong === null ? 'null' : typeof wrong}`);
  }

  // 6. ifMatch on a deleted key, and deletes of missing keys.
  {
    const k = `${prefix}deleted.json`;
    const { etag } = await store.put(k, '"x"', { create: true });
    await store.delete(k);
    let e1: unknown = null;
    let created = false;
    await store
      .put(k, '"resurrected"', { ifMatch: etag })
      .then(() => (created = true))
      .catch((e: unknown) => (e1 = e));
    const after = await store.get(k);
    record(
      'ifMatch on a deleted key: refused, nothing created (ADR 0012 never relies on this)',
      !created && after === null && e1 instanceof PreconditionFailedError,
      `outcome=${created ? 'CREATED' : `rejected (${errName(e1)}; mapped to PreconditionFailed=${e1 instanceof PreconditionFailedError})`}; now exists=${after !== null}`,
    );
    let e2: unknown = null;
    await del(`${prefix}never-existed.json`).catch((e: unknown) => (e2 = e));
    record('(info) deleting a missing key', true, e2 ? `throws ${errName(e2)}` : 'silently succeeds');
    const { etag: e3 } = await store.put(`${prefix}del-ifmatch.json`, '1', { create: true });
    await store.put(`${prefix}del-ifmatch.json`, '2', { ifMatch: e3 });
    let e4: unknown = null;
    await del(`${prefix}del-ifmatch.json`, { ifMatch: e3 }).catch((e: unknown) => (e4 = e));
    record('(info) del with a stale ifMatch', true, e4 ? `refused: ${errName(e4)} (precondition=${e4 instanceof BlobPreconditionFailedError})` : 'DELETED anyway');
  }

  // 7. The real sync repository end to end on Blob: concurrent CAS through the manifest.
  {
    const repo = new SyncRepository(new PrefixedStore(store, prefix));
    const enc = (s: string) => new TextEncoder().encode(s);
    const first = await repo.put('a.md', enc('base'), { ifNoneMatch: true });
    const outcomes = await settle(Array.from({ length: 10 }, (_, i) => repo.put('a.md', enc(`v${i + 1}`), { ifMatch: first.rev })));
    const wins = outcomes.filter((o) => o.status === 'fulfilled').length;
    const conflicts = outcomes.filter((o) => o.status === 'rejected' && (o as PromiseRejectedResult).reason instanceof SyncConflictError).length;
    record('SyncRepository on real Blob: 10 concurrent If-Match updates → 1 wins, 9 get 412', wins === 1 && conflicts === 9, `wins=${wins} conflicts=${conflicts}`);
    const many = await settle(Array.from({ length: 10 }, (_, i) => repo.put(`f${i}.md`, enc(`x${i}`), { ifNoneMatch: true })));
    const m = await repo.manifest();
    record(
      'SyncRepository on real Blob: 10 concurrent creates of different files all land (CAS retries)',
      many.every((o) => o.status === 'fulfilled') && m.entries.filter((e) => !e.deleted).length === 11,
      `fulfilled=${many.filter((o) => o.status === 'fulfilled').length}/10 live entries=${m.entries.filter((e) => !e.deleted).length} errors=${JSON.stringify(many.filter((o) => o.status === 'rejected').map((o) => errName((o as PromiseRejectedResult).reason)))}`,
    );
    const fresh = new SyncRepository(new PrefixedStore(store, `${prefix}fresh-manifest/`));
    const firsts = await settle(Array.from({ length: 10 }, (_, i) => fresh.put(`n${i}.md`, enc(`n${i}`), { ifNoneMatch: true })));
    const fm = await fresh.manifest();
    record(
      'SyncRepository on real Blob: 10 concurrent writers creating the manifest itself all land',
      firsts.every((o) => o.status === 'fulfilled') && fm.entries.length === 10,
      `fulfilled=${firsts.filter((o) => o.status === 'fulfilled').length}/10 entries=${fm.entries.length} errors=${JSON.stringify(firsts.filter((o) => o.status === 'rejected').map((o) => errName((o as PromiseRejectedResult).reason)))}`,
    );
    const moved = await repo.move('a.md', 'b.md', m.entries.find((e) => e.path === 'a.md')!.rev);
    const got = await repo.get('b.md');
    record('SyncRepository on real Blob: move then read', new TextDecoder().decode(got!.bytes).startsWith('v') && moved.path === 'b.md', `b.md=${new TextDecoder().decode(got!.bytes)}`);
  }
}

/** Runs the sync repository under the throwaway prefix. */
class PrefixedStore {
  constructor(
    private readonly inner: BlobStore,
    private readonly p: string,
  ) {}
  get = (k: string) => this.inner.get(this.p + k);
  put = (k: string, v: string, o?: Parameters<BlobStore['put']>[2]) => this.inner.put(this.p + k, v, o);
  delete = (k: string) => this.inner.delete(this.p + k);
  list = async (pre: string) => (await this.inner.list(this.p + pre)).map((k) => k.slice(this.p.length));
  getBytes = (k: string) => this.inner.getBytes(this.p + k);
  putBytes = (k: string, b: Uint8Array, o?: Parameters<BlobStore['putBytes']>[2]) => this.inner.putBytes(this.p + k, b, o);
}

try {
  await main();
} catch (error) {
  record('script completed', false, errName(error));
} finally {
  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url));
    removed += page.blobs.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const left = (await list({ prefix })).blobs.length;
  console.log(`cleanup: removed ${removed} blob(s) under ${prefix}; remaining=${left}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
