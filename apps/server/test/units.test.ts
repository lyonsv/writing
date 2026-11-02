import { describe, expect, it } from 'vitest';

import { ConfigError, isAllowed, loadConfig, parseAllowedUsers, storeConfigFromEnv } from '../src/config';
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
  MARGIN_STORE: 'memory',
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

  it('refuses the production GitHub store outside production (ADR 0014/0021)', () => {
    const gh = { MARGIN_STORE: 'github', GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'lyonsv/margin-library' };
    const base = { ...ENV, ...gh, VERCEL: '1', PRODUCTION_GITHUB_STORE: 'lyonsv/margin-library@main' };
    expect(() => loadConfig({ ...base, VERCEL_ENV: 'preview', GITHUB_STORE_BRANCH: 'main' })).toThrow(/production store/);
    expect(() => loadConfig({ ...base, VERCEL_ENV: 'development', GITHUB_STORE_REPO: 'LyonsV/Margin-Library', GITHUB_STORE_BRANCH: 'MAIN' })).toThrow(/production store/);
    expect(loadConfig({ ...base, VERCEL_ENV: 'preview', GITHUB_STORE_BRANCH: 'preview' })).toBeTruthy();
    // Without PRODUCTION_GITHUB_STORE outside production: refused (fail closed).
    expect(() => loadConfig({ ...ENV, ...gh, GITHUB_STORE_BRANCH: 'preview', VERCEL: '1', VERCEL_ENV: 'preview' })).toThrow(/PRODUCTION_GITHUB_STORE/);
    // Production itself, and local runs (no VERCEL), are unaffected.
    expect(loadConfig({ ...base, VERCEL_ENV: 'production', GITHUB_STORE_BRANCH: 'main' })).toBeTruthy();
    expect(loadConfig({ ...ENV, ...gh, GITHUB_STORE_BRANCH: 'main' })).toBeTruthy();
  });

  it('store config fails closed when incomplete', () => {
    for (const patch of [
      {},
      { MARGIN_STORE: 'blob' },
      { MARGIN_STORE: 'github' },
      { MARGIN_STORE: 'github', GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'nope', GITHUB_STORE_BRANCH: 'b' },
      { MARGIN_STORE: 'github', GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'o/r' },
      { MARGIN_STORE: 'memory', VERCEL: '1' },
    ]) {
      expect(() => loadConfig({ ...ENV, MARGIN_STORE: undefined, ...patch }), JSON.stringify(patch)).toThrow(ConfigError);
    }
    expect(storeConfigFromEnv({ GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'o/r', GITHUB_STORE_BRANCH: 'preview' })).toMatchObject({ kind: 'github', repo: 'o/r' });
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

  it('storeFromEnv never throws at startup; a misconfigured store fails every call with ConfigError', async () => {
    const bad = storeFromEnv({ MARGIN_STORE: 'memory', VERCEL: '1' });
    await expect(bad.get('k')).rejects.toBeInstanceOf(ConfigError);
    await expect(storeFromEnv({}).put('k', 'v')).rejects.toBeInstanceOf(ConfigError);
    expect(storeFromEnv({ MARGIN_STORE: 'memory' })).toBeInstanceOf((await import('../src/store')).MemoryStore);
    expect(storeFromEnv({ MARGIN_STORE: 'github', GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'o/r', GITHUB_STORE_BRANCH: 'preview' })).toBeInstanceOf(
      (await import('../src/githubStore')).GitHubStore,
    );
  });
});

describe('MemoryStore', () => {
  it('ETags are content-derived, like the GitHub store (git blob shas)', async () => {
    const { MemoryStore } = await import('../src/store');
    const m = new MemoryStore();
    const a = await m.put('k', 'same');
    const b = await m.put('k', 'other');
    const c = await m.put('k', 'same');
    expect(a.etag).toBe(c.etag);
    expect(a.etag).not.toBe(b.etag);
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

describe('ALLOW_NATIVE_SCHEME_REDIRECT (dev-only margin:// redirect)', () => {
  const base = {
    PUBLIC_URL: 'https://margin.test',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    ALLOWED_GITHUB_LOGINS: 'lyonsv:1',
    AUTH_SECRET: 'x'.repeat(40),
    MARGIN_STORE: 'memory',
  };
  it('is off unless set to 1', () => {
    expect(loadConfig(base).allowNativeSchemeRedirect).toBe(false);
    expect(loadConfig({ ...base, ALLOW_NATIVE_SCHEME_REDIRECT: 'true' }).allowNativeSchemeRedirect).toBe(false);
    expect(loadConfig({ ...base, ALLOW_NATIVE_SCHEME_REDIRECT: '1' }).allowNativeSchemeRedirect).toBe(true);
  });
  it('fails closed in Production', () => {
    // A valid production store, so the only reason to fail is the dev-only redirect flag.
    const prodStore = { MARGIN_STORE: 'github', GITHUB_STORE_TOKEN: 't', GITHUB_STORE_REPO: 'o/r', GITHUB_STORE_BRANCH: 'main' };
    expect(loadConfig({ ...base, ...prodStore, VERCEL: '1', VERCEL_ENV: 'production' })).toBeTruthy();
    expect(() => loadConfig({ ...base, ...prodStore, ALLOW_NATIVE_SCHEME_REDIRECT: '1', VERCEL: '1', VERCEL_ENV: 'production' })).toThrow(ConfigError);
  });
});
