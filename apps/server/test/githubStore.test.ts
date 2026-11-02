import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { GitHubStore, GitHubStoreError, gitBlobSha } from '../src/githubStore';
import { PreconditionFailedError } from '../src/store';
import { fakeGitHubContents } from './fakeGitHubContents';

function setup(raceRate = 0) {
  const gh = fakeGitHubContents({ raceRate });
  const store = new GitHubStore({ token: gh.token, repo: gh.repo, branch: gh.branch, fetch: gh.fetch, maxRaceRetries: 10 });
  return { gh, store };
}
const enc = (s: string) => new TextEncoder().encode(s);

describe('GitHubStore (ADR 0021)', () => {
  it('git blob sha matches git (known vector)', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(enc('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('round-trips bytes; the ETag is the git blob sha; 404 is null', async () => {
    const { store } = setup();
    expect(await store.get('a/b.json')).toBeNull();
    const { etag } = await store.put('a/b.json', '{"x":1}', { create: true });
    expect(etag).toBe(`"${gitBlobSha(enc('{"x":1}'))}"`);
    expect(await store.get('a/b.json')).toEqual({ value: '{"x":1}', etag });
    const bin = new Uint8Array([0, 255, 1, 254, 0x0d, 0x0a]);
    await store.putBytes('o/bin', bin, { create: true });
    expect((await store.getBytes('o/bin'))!.bytes).toEqual(bin);
  });

  it('reads files over 1 MB (raw media type), e.g. a 4 MiB document', async () => {
    const { store } = setup();
    const big = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 251);
    await store.putBytes('sync/objects/big', big, { create: true });
    const got = await store.getBytes('sync/objects/big');
    expect(createHash('sha256').update(got!.bytes).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('create-only fails on an existing key; ifMatch fails when stale or missing; never overwrites', async () => {
    const { store } = setup();
    const a = await store.put('k.json', '"a"', { create: true });
    await expect(store.put('k.json', '"b"', { create: true })).rejects.toBeInstanceOf(PreconditionFailedError);
    const b = await store.put('k.json', '"b"', { ifMatch: a.etag });
    await expect(store.put('k.json', '"c"', { ifMatch: a.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(store.put('missing.json', '"c"', { ifMatch: b.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await store.get('k.json'))!.value).toBe('"b"');
    expect(await store.get('missing.json')).toBeNull();
  });

  it('a lost branch-head race is retried to success; the condition still holds', async () => {
    const { gh, store } = setup();
    const a = await store.put('k.json', '"a"', { create: true });
    gh.forceRaces(3);
    await expect(store.put('k.json', '"b"', { ifMatch: a.etag })).resolves.toBeTruthy();
    expect((await store.get('k.json'))!.value).toBe('"b"');
    gh.forceRaces(2);
    await expect(store.put('new.json', '"n"', { create: true })).resolves.toBeTruthy();
    expect(gh.stats.races).toBe(5);
  });

  it('a real sha mismatch is never turned into a success, even when races happen too', async () => {
    const { gh, store } = setup();
    const a = await store.put('k.json', '"a"', { create: true });
    await store.put('k.json', '"someone else"', { ifMatch: a.etag });
    gh.forceRaces(2); // races first, then the genuine mismatch
    await expect(store.put('k.json', '"mine"', { ifMatch: a.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await store.get('k.json'))!.value).toBe('"someone else"');
    // Create-only racing with a real creation: precondition, not success.
    gh.forceRaces(1);
    gh.onBeforeWrite((p) => {
      if (p === 'c.json' && !gh.files.has('c.json')) gh.files.set('c.json', enc('"theirs"'));
      gh.onBeforeWrite(undefined);
    });
    await expect(store.put('c.json', '"mine"', { create: true })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await store.get('c.json'))!.value).toBe('"theirs"');
  });

  it('gives up with an error (not a fake success) if the branch stays busy', async () => {
    const gh = fakeGitHubContents();
    const store = new GitHubStore({ token: gh.token, repo: gh.repo, branch: gh.branch, fetch: gh.fetch, maxRaceRetries: 3 });
    gh.forceRaces(100);
    await expect(store.put('k.json', '"a"', { create: true })).rejects.toBeInstanceOf(GitHubStoreError);
    expect(gh.files.has('k.json')).toBe(false);
  });

  it('N concurrent ifMatch writers under random races: exactly one wins, the rest are precondition failures', async () => {
    const { store } = setup(0.3);
    const { etag } = await store.put('m.json', '0', { create: true });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => store.put('m.json', String(i + 1), { ifMatch: etag })));
    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof PreconditionFailedError)).toBe(true);
  });

  it('N concurrent create-only writers of different files under random races all land', async () => {
    const { gh, store } = setup(0.3);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => store.put(`f/${i}.json`, String(i), { create: true })));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(gh.files.size).toBe(10);
  });

  it('conditional reads: unchanged values come back as 304 (free against the rate limit)', async () => {
    const { gh, store } = setup();
    await store.put('sync/manifest.json', '{"seq":1}', { create: true });
    await store.get('sync/manifest.json');
    const before = gh.stats.notModified;
    for (let i = 0; i < 5; i++) expect((await store.get('sync/manifest.json'))!.value).toBe('{"seq":1}');
    expect(gh.stats.notModified - before).toBe(5);
    await store.put('sync/manifest.json', '{"seq":2}');
    expect((await store.get('sync/manifest.json'))!.value).toBe('{"seq":2}'); // a write invalidates
  });

  it('deletes (missing is fine) and lists recursively by prefix', async () => {
    const { store } = setup();
    for (const k of ['auth/devices/a.json', 'auth/devices/b.json', 'auth/used.json', 'sync/manifest.json']) await store.put(k, '1', { create: true });
    expect(await store.list('auth/devices/')).toEqual(['auth/devices/a.json', 'auth/devices/b.json']);
    expect((await store.list('')).length).toBe(4);
    await store.delete('auth/devices/a.json');
    await store.delete('auth/devices/never.json');
    expect(await store.list('auth/')).toEqual(['auth/devices/b.json', 'auth/used.json']);
  });

  it('sends the token only as a bearer header and writes only to the configured branch', async () => {
    const gh = fakeGitHubContents();
    const seen: string[] = [];
    const store = new GitHubStore({
      token: gh.token,
      repo: gh.repo,
      branch: gh.branch,
      fetch: async (input, init) => {
        seen.push(`${input} ${init?.body ?? ''}`);
        return gh.fetch(input, init);
      },
    });
    await store.put('x.json', '1', { create: true });
    await store.get('x.json');
    expect(seen.join('\n')).not.toContain(gh.token);
    expect(seen.some((s) => s.includes('"branch":"preview"'))).toBe(true);
    expect(() => new GitHubStore({ token: 't', repo: 'not a repo', branch: 'b' })).toThrow();
  });
});

describe('GitHub rate limits → StoreBusyError → 503 + Retry-After (validator MINOR)', () => {
  const limited = (status: number, headers: Record<string, string>, message = 'error') => async () =>
    new Response(JSON.stringify({ message }), { status, headers });

  it('recognises 429, secondary limits (403 + retry-after or message) and exhausted primary limits; not plain 403s', async () => {
    const { StoreBusyError } = await import('../src/store');
    const cases: Array<[() => Promise<Response>, number | null]> = [
      [limited(429, {}), 60],
      [limited(429, { 'retry-after': '17' }), 17],
      [limited(403, { 'retry-after': '90' }, 'You have exceeded a secondary rate limit'), 90],
      [limited(403, {}, 'You have exceeded a secondary rate limit. Please wait a few minutes.'), 60],
      [limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }), 120],
      [limited(403, {}, 'Resource not accessible by personal access token'), null],
    ];
    for (const [fetchImpl, seconds] of cases) {
      const store = new GitHubStore({ token: 't', repo: 'o/r', branch: 'preview', fetch: fetchImpl });
      const err = await store.get('x.json').catch((e: unknown) => e);
      if (seconds === null) {
        expect(err).toBeInstanceOf(GitHubStoreError);
        expect(err).not.toBeInstanceOf(StoreBusyError);
      } else {
        expect(err).toBeInstanceOf(StoreBusyError);
        expect(Math.abs((err as InstanceType<typeof StoreBusyError>).retryAfterSeconds - seconds)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the API answers 503 with Retry-After when storage is rate-limited', async () => {
    const { setup, signIn, bearer } = await import('./helpers');
    const { StoreBusyError } = await import('../src/store');
    const h = setup();
    const { token } = await signIn(h);
    const realGet = h.store.get.bind(h.store);
    h.store.get = async (key: string) => {
      if (key === 'sync/manifest.json') throw new StoreBusyError(42);
      return realGet(key);
    };
    const res = await h.req('/api/sync/manifest', bearer(token));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toEqual({ error: 'busy' });
  });
});
