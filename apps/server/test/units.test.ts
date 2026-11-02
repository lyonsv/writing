import { BlobPreconditionFailedError } from '@vercel/blob';
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

  it('lists across pages', async () => {
    const { client } = fakeClient();
    expect(await new BlobStore(client).list('auth/')).toEqual(['auth/a', 'auth/b']);
  });
});
