import { NATIVE_CUSTOM_SCHEME_REDIRECT } from '@margin/core';
import { describe, expect, it } from 'vitest';

import { PUBLIC_ROUTES, createApp } from '../src/app';
import { ConfigError } from '../src/config';
import { CODE_TTL_MS } from '../src/codes';
import { TOKEN_TTL_MS } from '../src/devices';
import { CUSTOM_SCHEME_REDIRECT } from '../src/redirects';
import { MemoryStore } from '../src/store';
import {
  Jar,
  LOOPBACK,
  OWNER,
  bearer,
  exchange,
  nativeAuthorize,
  newVerifier,
  s256,
  setup,
  signIn,
} from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('native sign-in (RFC 8252 + PKCE)', () => {
  it('happy path: issues a device token and /api/me works', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    expect(a.callback!.status).toBe(302);
    expect(a.location!.origin + a.location!.pathname).toBe(LOOPBACK);
    expect(a.location!.searchParams.get('state')).toBe(a.appState);
    const code = a.location!.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const res = await exchange(h, { code, code_verifier: a.verifier, redirect_uri: LOOPBACK, device_name: 'Vincent’s MacBook' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; login: string; device: { id: string; name: string; kind: string } };
    expect(body.token).toMatch(/^mgn_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(body.login).toBe('lyonsv');
    expect(body.device).toMatchObject({ name: 'Vincent’s MacBook', kind: 'native' });

    const me = await h.req('/api/me', bearer(body.token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ login: 'lyonsv', githubId: OWNER.id, device: { id: body.device.id, current: true } });
    expect(me.headers.get('Cache-Control')).toBe('no-store');
  });

  it('never exposes the GitHub token, and stores only hashes', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const res = await exchange(h, {
      code: a.location!.searchParams.get('code'),
      code_verifier: a.verifier,
      redirect_uri: LOOPBACK,
    });
    const text = await res.text();
    const { token } = JSON.parse(text) as { token: string };
    const ghToken = h.github.issuedTokens[0]!;
    expect(ghToken).toBeTruthy();
    // Not in any response…
    expect(text).not.toContain(ghToken);
    expect(a.location!.toString()).not.toContain(ghToken);
    // …nor in storage, which also never holds the device token, its secret or the one-time code.
    const secret = token.split('.')[1]!;
    for (const key of await h.store.list('')) {
      const value = (await h.store.get(key))!.value;
      for (const s of [ghToken, token, secret, a.location!.searchParams.get('code')!]) {
        expect(value).not.toContain(s);
        expect(key).not.toContain(s);
      }
    }
    // …nor in the logs.
    const logged = JSON.stringify(h.logs);
    for (const s of [ghToken, token, secret, a.location!.searchParams.get('code')!, a.githubCode!, a.githubState!, a.appState]) {
      expect(logged).not.toContain(s);
    }
  });

  it('rejects a reused one-time code', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const body = { code: a.location!.searchParams.get('code'), code_verifier: a.verifier, redirect_uri: LOOPBACK };
    expect((await exchange(h, body)).status).toBe(200);
    const again = await exchange(h, body);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_grant' });
  });

  it('lets exactly one of several concurrent redemptions win', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const body = { code: a.location!.searchParams.get('code'), code_verifier: a.verifier, redirect_uri: LOOPBACK };
    const results = await Promise.all(Array.from({ length: 8 }, () => exchange(h, body)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400, 400, 400, 400]);
  });

  it('rejects the wrong PKCE verifier, and the attempt burns the code', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const code = a.location!.searchParams.get('code');
    expect((await exchange(h, { code, code_verifier: newVerifier(), redirect_uri: LOOPBACK })).status).toBe(400);
    expect((await exchange(h, { code, code_verifier: a.verifier, redirect_uri: LOOPBACK })).status).toBe(400);
  });

  it('rejects a code redeemed with a different redirect_uri', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const res = await exchange(h, {
      code: a.location!.searchParams.get('code'),
      code_verifier: a.verifier,
      redirect_uri: 'http://127.0.0.1:9999/callback',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an expired one-time code', async () => {
    let t = Date.now();
    const h = setup({ now: () => t });
    const a = await nativeAuthorize(h);
    t += CODE_TTL_MS + 1;
    const res = await exchange(h, { code: a.location!.searchParams.get('code'), code_verifier: a.verifier, redirect_uri: LOOPBACK });
    expect(res.status).toBe(400);
  });

  it('rejects malformed exchange requests', async () => {
    const h = setup();
    expect((await exchange(h, {})).status).toBe(400);
    expect((await exchange(h, { code: 'x', code_verifier: 'short', redirect_uri: LOOPBACK })).status).toBe(400);
    const bad = await h.req('/api/auth/native/token', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    const huge = await exchange(h, { code: 'x'.repeat(20_000) });
    expect(huge.status).toBe(413);
  });

  it('rejects a bad, missing, replayed or foreign state at the GitHub callback', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    // Replaying the same callback: the pending-sign-in cookie was consumed.
    const replay = await h.req(`/api/auth/github/callback?code=${a.githubCode}&state=${a.githubState}`, {
      headers: { Cookie: a.jar.header() },
    });
    expect(replay.status).toBe(400);
    expect(replay.headers.get('Location')).toBeNull();

    // A fresh start, but the callback carries a different state.
    const jar = new Jar();
    const start = await h.req(
      `/api/auth/native/start?redirect_uri=${encodeURIComponent(LOOPBACK)}&code_challenge=${s256(newVerifier())}&code_challenge_method=S256&state=appstate-0123456789`,
    );
    jar.absorb(start);
    const { code } = h.github.approve(start.headers.get('Location')!, OWNER);
    const wrong = await h.req(`/api/auth/github/callback?code=${code}&state=attacker-state`, { headers: { Cookie: jar.header() } });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get('Location')).toBeNull();

    // No cookie at all (login CSRF: attacker sends the victim their own callback URL).
    const noCookie = await h.req(`/api/auth/github/callback?code=${code}&state=whatever`);
    expect(noCookie.status).toBe(400);

    // A tampered cookie.
    const tampered = jar.header().replace(/=(.)/, (_m, ch: string) => `=${ch === 'A' ? 'B' : 'A'}`);
    const t = await h.req(`/api/auth/github/callback?code=${code}&state=x`, { headers: { Cookie: tampered } });
    expect(t.status).toBe(400);
    expect(h.github.calls).toHaveLength(2); // only the two legitimate exchanges ever reached GitHub
  });

  it('rejects an expired pending sign-in', async () => {
    let t = Date.now();
    const h = setup({ now: () => t });
    const jar = new Jar();
    const start = await h.req(
      `/api/auth/native/start?redirect_uri=${encodeURIComponent(LOOPBACK)}&code_challenge=${s256(newVerifier())}&code_challenge_method=S256&state=appstate-0123456789`,
    );
    jar.absorb(start);
    const { code, state } = h.github.approve(start.headers.get('Location')!, OWNER);
    t += 11 * 60 * 1000;
    const res = await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, { headers: { Cookie: jar.header() } });
    expect(res.status).toBe(400);
  });

  it('refuses a GitHub user who is not on the allowlist', async () => {
    const h = setup();
    const a = await nativeAuthorize(h, { login: 'mallory', id: 999 });
    expect(a.location!.searchParams.get('error')).toBe('access_denied');
    expect(a.location!.searchParams.get('code')).toBeNull();
    expect(a.location!.searchParams.get('state')).toBe(a.appState);
    expect(await h.store.list('auth/')).toEqual([]);
  });

  it('refuses a recycled username (allowlisted login, different GitHub id)', async () => {
    const h = setup();
    const a = await nativeAuthorize(h, { login: 'LyonsV', id: 7654321 });
    expect(a.location!.searchParams.get('error')).toBe('access_denied');
  });

  it('refuses a renamed account (allowlisted id, different login) until the allowlist is updated', async () => {
    const h = setup();
    const a = await nativeAuthorize(h, { login: 'someone-else', id: OWNER.id });
    expect(a.location!.searchParams.get('error')).toBe('access_denied');
  });

  it('matches the allowlisted login case-insensitively', async () => {
    const h = setup();
    const a = await nativeAuthorize(h, { login: 'LyonsV', id: OWNER.id });
    expect(a.location!.searchParams.get('code')).toBeTruthy();
  });

  it('sends a cancelled GitHub consent back to the app as access_denied', async () => {
    const h = setup();
    const jar = new Jar();
    const start = await h.req(
      `/api/auth/native/start?redirect_uri=${encodeURIComponent(LOOPBACK)}&code_challenge=${s256(newVerifier())}&code_challenge_method=S256&state=appstate-0123456789`,
    );
    jar.absorb(start);
    const state = new URL(start.headers.get('Location')!).searchParams.get('state');
    const res = await h.req(`/api/auth/github/callback?error=access_denied&state=${state}`, { headers: { Cookie: jar.header() } });
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('appstate-0123456789');
  });

  it('reports GitHub being down to the app without leaking details', async () => {
    const h = setup();
    const jar = new Jar();
    const start = await h.req(
      `/api/auth/native/start?redirect_uri=${encodeURIComponent(LOOPBACK)}&code_challenge=${s256(newVerifier())}&code_challenge_method=S256&state=appstate-0123456789`,
    );
    jar.absorb(start);
    const { code, state } = h.github.approve(start.headers.get('Location')!, OWNER);
    h.github.down = true;
    const res = await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, { headers: { Cookie: jar.header() } });
    expect(new URL(res.headers.get('Location')!).searchParams.get('error')).toBe('server_error');
  });

  it('accepts the iOS custom scheme redirect', async () => {
    expect(CUSTOM_SCHEME_REDIRECT).toBe(NATIVE_CUSTOM_SCHEME_REDIRECT);
    const h = setup();
    const a = await nativeAuthorize(h, OWNER, { redirectUri: 'margin://auth/callback' });
    expect(a.location!.protocol).toBe('margin:');
    expect(a.location!.searchParams.get('code')).toBeTruthy();
  });

  it('sends PKCE to GitHub and keeps its own verifier server-side', async () => {
    const h = setup();
    const a = await nativeAuthorize(h);
    const authorize = new URL(a.start.headers.get('Location')!);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://margin.test/api/auth/github/callback');
    // GitHub's challenge is ours, not the app's.
    expect(authorize.searchParams.get('code_challenge')).not.toBe(s256(a.verifier));
    const cookie = a.start.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^__Host-margin_oauth=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe('open redirects', () => {
  const evil = [
    'https://evil.example/callback',
    'http://evil.example/callback',
    'http://127.0.0.1.evil.example:8080/callback',
    'http://127.0.0.1@evil.example:8080/callback',
    'http://evil.example#@127.0.0.1:8080/callback',
    'http://localhost:8080/callback',
    'http://127.0.0.1:8080/callback?next=https://evil.example',
    'http://127.0.0.1:8080/callback#x',
    'http://127.0.0.1:8080/other',
    'http://127.0.0.1:8080//callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:80/callback',
    'http://127.0.0.1:99999/callback',
    'https://127.0.0.1:8080/callback',
    'http://0x7f000001:8080/callback',
    'margin://auth/callback/../../evil',
    'margin://evil/callback',
    'margin://auth/callback?x=1',
    'javascript:alert(1)',
    '//evil.example/callback',
    '',
  ];

  for (const uri of evil) {
    it(`refuses native redirect_uri ${JSON.stringify(uri)} without redirecting`, async () => {
      const h = setup();
      const res = await h.req(
        `/api/auth/native/start?${new URLSearchParams({ redirect_uri: uri, code_challenge: s256(newVerifier()), code_challenge_method: 'S256', state: 'appstate-0123456789' })}`,
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
      expect(h.github.calls).toEqual([]);
    });
  }

  it('refuses a start without S256 PKCE or with a malformed state', async () => {
    const h = setup();
    const v = newVerifier();
    const base = { redirect_uri: LOOPBACK, code_challenge: s256(v), code_challenge_method: 'S256', state: 'appstate-0123456789' };
    for (const patch of [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }, { state: 'x' }, { state: '<script>alert(1)</script>-xxxxxxx' }]) {
      const res = await h.req(`/api/auth/native/start?${new URLSearchParams({ ...base, ...patch })}`);
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
      expect(await res.text()).not.toContain('<script>');
    }
  });

  for (const target of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/%5Cevil.example', 'javascript:alert(1)', ' /x', '/\t/evil.example']) {
    it(`web return_to ${JSON.stringify(target)} lands on this origin`, async () => {
      const h = setup();
      const jar = new Jar();
      const start = await h.req(`/api/auth/web/start?return_to=${encodeURIComponent(target)}`);
      jar.absorb(start);
      const { code, state } = h.github.approve(start.headers.get('Location')!, OWNER);
      const cb = await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, { headers: { Cookie: jar.header() } });
      const loc = cb.headers.get('Location')!;
      expect(new URL(loc, 'https://margin.test').origin).toBe('https://margin.test');
      expect(loc.startsWith('/')).toBe(true);
      expect(loc.startsWith('//')).toBe(false);
    });
  }
});

describe('the auth gate', () => {
  it('rejects requests with no token, a malformed token or a forged token', async () => {
    const h = setup();
    const { token } = await signIn(h);
    const [id] = token.slice(4).split('.');
    const forged = `mgn_${id}.${'A'.repeat(43)}`;
    const cases: Array<Record<string, string>> = [
      {},
      { Authorization: '' },
      { Authorization: 'Bearer' },
      { Authorization: 'Bearer ' },
      { Authorization: `Basic ${token}` },
      { Authorization: `Bearer ${token} extra` },
      { Authorization: `Bearer ${token}x` },
      { Authorization: `Bearer ${token.slice(0, -1)}` },
      { Authorization: 'Bearer mgn_' },
      { Authorization: 'Bearer mgn_../../etc/passwd.x' },
      { Authorization: `Bearer ${forged}` },
      { Authorization: `Bearer mgn_${'B'.repeat(22)}.${'C'.repeat(43)}` },
    ];
    for (const headers of cases) {
      const res = await h.req('/api/me', { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' }); // no detail about why
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    }
  });

  it('protects every registered route except the public auth routes', async () => {
    const h = setup();
    const registered = new Set(
      h.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
    );
    for (const p of PUBLIC_ROUTES) expect(registered.has(p), p).toBe(true);
    const guarded = [...registered].filter((r) => !PUBLIC_ROUTES.has(r));
    expect(guarded.length).toBeGreaterThanOrEqual(4);
    for (const route of guarded) {
      const [method, path] = route.split(' ') as [string, string];
      const res = await h.req(path.replace(':id', 'AAAAAAAAAAAAAAAAAAAAAA'), { method });
      expect(res.status, route).toBe(401);
    }
  });

  it('requires a token even for unknown paths (no route discovery)', async () => {
    const h = setup();
    expect((await h.req('/api/nope')).status).toBe(401);
    expect((await h.req('/')).status).toBe(401);
    expect((await h.req('/api/auth/native/start/', { method: 'GET' })).status).toBe(401);
    expect((await h.req('/api/auth/native/token', { method: 'GET' })).status).toBe(401);
    const { token } = await signIn(h);
    expect((await h.req('/api/nope', bearer(token))).status).toBe(404);
  });

  it('rejects a revoked token', async () => {
    const h = setup();
    const a = await signIn(h, 'Mac');
    const b = await signIn(h, 'iPhone');
    const del = await h.req(`/api/devices/${b.deviceId}`, { method: 'DELETE', ...bearer(a.token) });
    expect(del.status).toBe(204);
    expect((await h.req('/api/me', bearer(b.token))).status).toBe(401);
    expect((await h.req('/api/me', bearer(a.token))).status).toBe(200);
    // Revoking again is a 404, and so is an unknown or malformed id.
    expect((await h.req(`/api/devices/${b.deviceId}`, { method: 'DELETE', ...bearer(a.token) })).status).toBe(404);
    expect((await h.req('/api/devices/nope', { method: 'DELETE', ...bearer(a.token) })).status).toBe(404);
    expect((await h.req('/api/devices/..%2F..%2Fx', { method: 'DELETE', ...bearer(a.token) })).status).toBe(404);
  });

  it('signout revokes only the current device', async () => {
    const h = setup();
    const a = await signIn(h, 'Mac');
    const b = await signIn(h, 'iPhone');
    expect((await h.req('/api/auth/signout', { method: 'POST', ...bearer(a.token) })).status).toBe(204);
    expect((await h.req('/api/me', bearer(a.token))).status).toBe(401);
    expect((await h.req('/api/me', bearer(b.token))).status).toBe(200);
  });

  it('lists devices without secrets and marks the current one', async () => {
    const h = setup();
    const a = await signIn(h, 'Mac');
    await signIn(h, 'iPhone');
    const res = await h.req('/api/devices', bearer(a.token));
    const text = await res.text();
    expect(text).not.toContain('tokenHash');
    const { devices } = JSON.parse(text) as { devices: Array<{ id: string; name: string; current: boolean }> };
    expect(devices.map((d) => d.name).sort()).toEqual(['Mac', 'iPhone']);
    expect(devices.find((d) => d.current)?.id).toBe(a.deviceId);
  });

  it('rejects an expired token; use rolls the expiry forward', async () => {
    let t = Date.now();
    const h = setup({ now: () => t });
    const active = await signIn(h, 'Active');
    const idle = await signIn(h, 'Idle');
    for (let i = 0; i < 4; i++) {
      t += 60 * DAY;
      expect((await h.req('/api/me', bearer(active.token))).status).toBe(200);
    }
    // 240 days in: the idle device lapsed at 90.
    expect((await h.req('/api/me', bearer(idle.token))).status).toBe(401);
    const me = (await (await h.req('/api/me', bearer(active.token))).json()) as { device: { expiresAt: string } };
    expect(Date.parse(me.device.expiresAt)).toBe(t + TOKEN_TTL_MS);
    t += TOKEN_TTL_MS;
    expect((await h.req('/api/me', bearer(active.token))).status).toBe(401);
  });

  it('cuts off existing devices when the user is removed from the allowlist', async () => {
    const store = new MemoryStore();
    const { MockGitHub, testConfig } = await import('./helpers');
    const gh = new MockGitHub();
    let config = testConfig();
    const make = () => createApp({ config, store, fetch: gh.fetch, log: () => {} });
    const h = { app: make(), store, github: gh, logs: [], config, req: (p: string, i?: RequestInit) => make().request(`https://margin.test${p}`, i) };
    const { token } = await signIn(h as never);
    expect((await h.req('/api/me', bearer(token))).status).toBe(200);
    config = testConfig({ allowedUsers: [{ login: 'someoneelse', id: 1 }] });
    expect((await h.req('/api/me', bearer(token))).status).toBe(401);
  });

  it('concurrent use and revoke end revoked (smoke; exact interleavings are in concurrency.test.ts)', async () => {
    let t = Date.now();
    const h = setup({ now: () => t });
    const a = await signIn(h, 'Mac');
    const b = await signIn(h, 'iPhone');
    t += 2 * 60 * 60 * 1000; // past the touch interval, so the next use writes
    await Promise.all([
      h.req('/api/me', bearer(b.token)),
      h.req(`/api/devices/${b.deviceId}`, { method: 'DELETE', ...bearer(a.token) }),
      h.req('/api/me', bearer(b.token)),
    ]);
    expect((await h.req('/api/me', bearer(b.token))).status).toBe(401);
    const list = (await (await h.req('/api/devices', bearer(a.token))).json()) as { devices: Array<{ id: string }> };
    expect(list.devices.map((d) => d.id)).toEqual([a.deviceId]);
  });
});

describe('hosted web cookie session', () => {
  async function webSignIn(h: ReturnType<typeof setup>) {
    const jar = new Jar();
    const start = await h.req('/api/auth/web/start?return_to=/library?x=1');
    jar.absorb(start);
    const { code, state } = h.github.approve(start.headers.get('Location')!, OWNER);
    const cb = await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, {
      headers: { Cookie: jar.header(), 'User-Agent': 'Mozilla/5.0 Safari/605.1.15' },
    });
    jar.absorb(cb);
    return { jar, cb };
  }

  it('issues an HttpOnly, Secure, SameSite=Lax session cookie and lands on return_to', async () => {
    const h = setup();
    const { jar, cb } = await webSignIn(h);
    expect(cb.headers.get('Location')).toBe('/library?x=1');
    const session = jar.raw.find((c) => c.startsWith('__Host-margin_session='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    const me = await h.req('/api/me', { headers: { Cookie: jar.header() } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { device: { kind: string; name: string } }).device).toMatchObject({ kind: 'web', name: 'Web (Safari)' });
  });

  it('requires a same-origin Origin header for cookie-authenticated writes (CSRF)', async () => {
    const h = setup();
    const { jar } = await webSignIn(h);
    const noOrigin = await h.req('/api/auth/signout', { method: 'POST', headers: { Cookie: jar.header() } });
    expect(noOrigin.status).toBe(403);
    const foreign = await h.req('/api/auth/signout', { method: 'POST', headers: { Cookie: jar.header(), Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const ok = await h.req('/api/auth/signout', { method: 'POST', headers: { Cookie: jar.header(), Origin: 'https://margin.test' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.getSetCookie().join()).toMatch(/__Host-margin_session=;.*Max-Age=0/);
    expect((await h.req('/api/me', { headers: { Cookie: jar.header() } })).status).toBe(401);
  });

  it('refuses a non-allowlisted user with a plain page, no session', async () => {
    const h = setup();
    const jar = new Jar();
    const start = await h.req('/api/auth/web/start');
    jar.absorb(start);
    const { code, state } = h.github.approve(start.headers.get('Location')!, { login: 'mallory', id: 5 });
    const cb = await h.req(`/api/auth/github/callback?code=${code}&state=${state}`, { headers: { Cookie: jar.header() } });
    expect(cb.status).toBe(403);
    expect(cb.headers.get('Location')).toBeNull();
    expect(cb.headers.getSetCookie().join()).not.toMatch(/margin_session=[^;]/);
  });
});

describe('hygiene', () => {
  it('rate-limits the auth endpoints per client', async () => {
    const h = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await exchange(h, {})).status);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    // Another client is unaffected.
    const other = await h.req('/api/auth/native/token', { method: 'POST', body: '{}', headers: { 'x-real-ip': '10.0.0.2', 'Content-Type': 'application/json' } });
    expect(other.status).toBe(400);
  });

  it('fails closed with a generic 500 when configuration is incomplete', async () => {
    const logs: string[] = [];
    const app = createApp({
      config: () => {
        throw new ConfigError('GITHUB_CLIENT_SECRET is not set');
      },
      store: new MemoryStore(),
      log: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`),
    });
    for (const p of ['/api/me', '/api/auth/native/start', '/api/auth/web/start']) {
      const res = await app.request(`https://margin.test${p}`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"server_error"}');
    }
    expect(logs[0]).toContain('config.error');
  });

  it('sets hardening headers', async () => {
    const h = setup();
    const res = await h.req('/api/me');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
