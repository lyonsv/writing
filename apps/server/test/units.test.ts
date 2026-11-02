import { BlobError, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { describe, expect, it } from 'vitest';

import { BlobStore, type BlobClient } from '../src/blobStore';
import { ConfigError, isAllowed, loadConfig, parseAllowedUsers } from '../src/config';
import { Sealer, hashMatches, pkceChallenge, safeEqual, sha256Hex } from '../src/crypto';
import { cleanDeviceName } from '../src/devices';
import { storeFromEnv } from '../src/env';
import { RateLimiter } from '../src/rateLimit';
import { PreconditionFailedError } from '../src/store';

const ENV = {
  PUBLIC_URL: 'https://margin.example.com',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
  ALLOWED_GITHUB_LOGINS: 'lyonsv:1234567',
  AUTH_SECRET: 's'.repeat(32),
};

describe('config', () => {
  it('parses a complete environment', () => {
    const c = loadConfig(ENV);
    expect(c.publicUrl.origin).toBe('https://margin.example.com');
    expect(c.secureCookies).toBe(true);
    expect(c.githubOAuthUrl).toBe('https://github.com');
  });

  it('fails closed on anything missing or unsafe', () => {
    for (const patch of [
      { PUBLIC_URL: undefined },
      { PUBLIC_URL: 'http://margin.example.com' },
      { PUBLIC_URL: 'https://margin.example.com/app' },
      { GITHUB_CLIENT_SECRET: '' },
      { AUTH_SECRET: 'short' },
      { ALLOWED_GITHUB_LOGINS: '' },
      { ALLOWED_GITHUB_LOGINS: 'lyonsv' },
      { ALLOWED_GITHUB_LOGINS: 'lyonsv:abc' },
      { ALLOWED_GITHUB_LOGINS: 'lyonsv:1,bad' },
      { GITHUB_OAUTH_URL: 'http://evil.example' },
    ]) {
      expect(() => loadConfig({ ...ENV, ...patch }), JSON.stringify(patch)).toThrow(ConfigError);
    }
  });

  it('derives PUBLIC_URL from VERCEL_URL on previews only', () => {
    const { PUBLIC_URL: _drop, ...rest } = ENV;
    expect(loadConfig({ ...rest, VERCEL_ENV: 'preview', VERCEL_URL: 'margin-sync-abc123.vercel.app' }).publicUrl.origin).toBe(
      'https://margin-sync-abc123.vercel.app',
    );
    expect(() => loadConfig({ ...rest, VERCEL_ENV: 'production', VERCEL_URL: 'margin-sync-abc123.vercel.app' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...rest, VERCEL_ENV: 'preview', VERCEL_URL: 'evil.example/x?' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
    // An explicit PUBLIC_URL always wins.
    expect(loadConfig({ ...ENV, VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app' }).publicUrl.origin).toBe('https://margin.example.com');
  });

  it('allows plain http only on loopback, without Secure cookies', () => {
    const c = loadConfig({ ...ENV, PUBLIC_URL: 'http://localhost:3000' });
    expect(c.secureCookies).toBe(false);
  });

  it('allowlist needs both login (case-insensitive) and id', () => {
    const users = parseAllowedUsers(' lyonsv:1234567 , Other-User:42 ');
    expect(users).toEqual([
      { login: 'lyonsv', id: 1234567 },
      { login: 'other-user', id: 42 },
    ]);
    expect(isAllowed(users, 'LyonsV', 1234567)).toBe(true);
    expect(isAllowed(users, 'lyonsv', 42)).toBe(false);
    expect(isAllowed(users, 'mallory', 1234567)).toBe(false);
  });
});

describe('crypto', () => {
  it('computes RFC 7636 S256 (appendix B vector)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(hashMatches(sha256Hex('s'), 's')).toBe(true);
    expect(hashMatches(sha256Hex('s'), 't')).toBe(false);
    expect(hashMatches('zz', 's')).toBe(false);
  });

  it('seals and rejects tampering or a different key', () => {
    const a = new Sealer('k'.repeat(32));
    const sealed = a.seal({ x: 1 });
    expect(a.unseal(sealed)).toEqual({ x: 1 });
    expect(new Sealer('j'.repeat(32)).unseal(sealed)).toBeNull();
    const bytes = Buffer.from(sealed, 'base64url');
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    expect(a.unseal(bytes.toString('base64url'))).toBeNull();
    expect(a.unseal('')).toBeNull();
    expect(a.unseal('!!!')).toBeNull();
  });
});

describe('misc', () => {
  it('cleans device names', () => {
    expect(cleanDeviceName('  Mac\u0000Book\n Pro  ')).toBe('Mac Book Pro');
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(64);
    expect(cleanDeviceName(42)).toBe('Unnamed device');
    expect(cleanDeviceName(' ')).toBe('Unnamed device');
  });

  it('rate limiter windows reset', () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.hit('a'), r.hit('a'), r.hit('a'), r.hit('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(r.hit('a')).toBe(true);
  });

  it('refuses the memory store on Vercel and an unconfigured Blob store', () => {
    expect(() => storeFromEnv({ MARGIN_STORE: 'memory', VERCEL: '1' })).toThrow();
    expect(() => storeFromEnv({})).toThrow();
    expect(storeFromEnv({ MARGIN_STORE: 'memory' })).toBeTruthy();
  });
});

describe('BlobStore', () => {
  function fakeClient() {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const client = {
      get: async (...args: unknown[]) => {
        calls.push({ op: 'get', args });
        return args[0] === 'missing'
          ? null
          : { statusCode: 200, stream: new Response('{"a":1}').body, headers: new Headers(), blob: { etag: '"e1"' } };
      },
      put: async (...args: unknown[]) => {
        calls.push({ op: 'put', args });
        if ((args[2] as { ifMatch?: string }).ifMatch === '"stale"') throw new BlobPreconditionFailedError();
        return { etag: '"e2"' };
      },
      del: async (...args: unknown[]) => void calls.push({ op: 'del', args }),
      list: async (...args: unknown[]) => {
        calls.push({ op: 'list', args });
        const cursor = (args[0] as { cursor?: string }).cursor;
        return cursor
          ? { blobs: [{ pathname: 'auth/b' }], hasMore: false }
          : { blobs: [{ pathname: 'auth/a' }], hasMore: true, cursor: 'c1' };
      },
    } as unknown as BlobClient;
    return { client, calls };
  }

  it('reads privately, bypassing the CDN cache', async () => {
    const { client, calls } = fakeClient();
    const s = new BlobStore(client);
    expect(await s.get('k')).toEqual({ value: '{"a":1}', etag: '"e1"' });
    expect(await s.get('missing')).toBeNull();
    expect(calls[0]!.args[1]).toEqual({ access: 'private', useCache: false });
  });

  it('maps ifMatch / create to Blob options and precondition errors to ours', async () => {
    const { client, calls } = fakeClient();
    const s = new BlobStore(client);
    await s.put('k', 'v', { ifMatch: '"e1"' });
    expect(calls[0]!.args[2]).toMatchObject({ access: 'private', ifMatch: '"e1"', allowOverwrite: true, addRandomSuffix: false });
    await s.put('k', 'v', { create: true });
    expect(calls[1]!.args[2]).toMatchObject({ allowOverwrite: false });
    expect((calls[1]!.args[2] as Record<string, unknown>).ifMatch).toBeUndefined();
    await expect(s.put('k', 'v', { ifMatch: '"stale"' })).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('maps real Blob conditional failures (generic BlobErrors) to PreconditionFailedError by checking the key', async () => {
    const make = (exists: boolean) =>
      new BlobStore({
        put: async () => {
          throw new BlobError(exists ? 'This blob already exists' : 'The specified key does not exist.');
        },
        head: async () => {
          if (!exists) throw new BlobNotFoundError();
          return { etag: '"e"' };
        },
      } as unknown as BlobClient);
    // create-only on an existing key (observed on real Blob)
    await expect(make(true).put('k', 'v', { create: true })).rejects.toBeInstanceOf(PreconditionFailedError);
    // ifMatch on a deleted key (observed on real Blob)
    await expect(make(false).put('k', 'v', { ifMatch: '"e"' })).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(make(false).putBytes('k', new Uint8Array([1]), { ifMatch: '"e"' })).rejects.toBeInstanceOf(PreconditionFailedError);
    // A losing concurrent write ("conflicting operation"): the key moved on to another ETag.
    const moved = new BlobStore({
      put: async () => {
        throw new BlobError('The conditional request cannot succeed due to a conflicting operation against this resource.');
      },
      head: async () => ({ etag: '"winner"' }),
    } as unknown as BlobClient);
    await expect(moved.put('k', 'v', { ifMatch: '"e"' })).rejects.toBeInstanceOf(PreconditionFailedError);
    // Errors that don't contradict the condition are real errors (ifMatch "e" still current).
    await expect(make(false).put('k', 'v', { create: true })).rejects.toBeInstanceOf(BlobError);
    await expect(make(false).put('k', 'v', { create: true })).rejects.not.toBeInstanceOf(PreconditionFailedError);
    await expect(make(true).put('k', 'v')).rejects.not.toBeInstanceOf(PreconditionFailedError);
    await expect(make(true).put('k', 'v', { ifMatch: '"e"' })).rejects.not.toBeInstanceOf(PreconditionFailedError);
  });

  it('MemoryStore ETags are content-derived, like real Blob', async () => {
    const { MemoryStore } = await import('../src/store');
    const m = new MemoryStore();
    const a = await m.put('k', 'same');
    const b = await m.put('k', 'other');
    const c = await m.put('k', 'same');
    expect(a.etag).toBe(c.etag);
    expect(a.etag).not.toBe(b.etag);
  });

  it('normalises weak ETags from get() (real Blob, compressed responses) so CAS can match', async () => {
    const s = new BlobStore({
      get: async () => ({ statusCode: 200, stream: new Response('{"big":1}').body, headers: new Headers(), blob: { etag: 'W/"abc"' } }),
    } as unknown as BlobClient);
    expect((await s.get('k'))!.etag).toBe('"abc"');
    expect((await s.getBytes('k'))!.etag).toBe('"abc"');
  });

  it('lists across pages', async () => {
    const { client } = fakeClient();
    expect(await new BlobStore(client).list('auth/')).toEqual(['auth/a', 'auth/b']);
  });
});

describe('deployability', () => {
  it('relative imports in src carry .js extensions (Vercel runs src as native ESM; extensionless imports crash at runtime)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      for (const m of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
        if (!m[1]!.endsWith('.js')) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Vercel entry (server.ts) default-exports the Hono app', async () => {
    process.env.MARGIN_STORE = 'memory';
    const mod = (await import('../server')) as { default: { fetch?: unknown } };
    expect(typeof mod.default.fetch).toBe('function');
    delete process.env.MARGIN_STORE;
  });
});
