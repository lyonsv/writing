import { createHash, randomBytes } from 'node:crypto';

import { createApp, type Logger } from '../src/createApp';
import type { Config } from '../src/config';
import { MemoryStore } from '../src/store';

export const OWNER = { login: 'lyonsv', id: 1234567 };

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: new URL('https://margin.test'),
    githubClientId: 'client-id',
    githubClientSecret: 'client-secret',
    allowedUsers: [{ login: OWNER.login, id: OWNER.id }],
    authSecret: 'x'.repeat(48),
    githubOAuthUrl: 'https://github.test',
    githubApiUrl: 'https://api.github.test',
    secureCookies: true,
    ...overrides,
  };
}

export const b64url = (b: Buffer) => b.toString('base64url');
export const s256 = (v: string) => b64url(createHash('sha256').update(v).digest());
export const newVerifier = () => b64url(randomBytes(32));

interface GitHubUser {
  id: number;
  login: string;
}

/**
 * Fake GitHub OAuth endpoints. Like the real thing, it checks client
 * credentials, the redirect_uri and the PKCE verifier, and codes are single-use.
 */
export class MockGitHub {
  private codes = new Map<string, { user: GitHubUser; challenge: string; redirectUri: string }>();
  private tokens = new Map<string, GitHubUser>();
  /** Every access token GitHub issued (to assert they never leak). */
  readonly issuedTokens: string[] = [];
  calls: string[] = [];
  down = false;

  /** Simulates the user approving on github.com/login/oauth/authorize. Returns the code. */
  approve(authorizeUrl: string, user: GitHubUser): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    if (u.origin !== 'https://github.test' || u.pathname !== '/login/oauth/authorize') throw new Error(`not GitHub: ${authorizeUrl}`);
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('no PKCE');
    const code = `gh_${b64url(randomBytes(12))}`;
    this.codes.set(code, {
      user,
      challenge: u.searchParams.get('code_challenge')!,
      redirectUri: u.searchParams.get('redirect_uri')!,
    });
    return { code, state: u.searchParams.get('state')! };
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    this.calls.push(input);
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(input);
    if (url.href === 'https://github.test/login/oauth/access_token') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const entry = this.codes.get(body.code!);
      this.codes.delete(body.code!);
      const ok =
        entry &&
        body.client_id === 'client-id' &&
        body.client_secret === 'client-secret' &&
        body.redirect_uri === entry.redirectUri &&
        s256(body.code_verifier ?? '') === entry.challenge;
      if (!ok) return Response.json({ error: 'bad_verification_code' });
      const token = `gho_${b64url(randomBytes(18))}`;
      this.tokens.set(token, entry.user);
      this.issuedTokens.push(token);
      return Response.json({ access_token: token, token_type: 'bearer', scope: '' });
    }
    if (url.href === 'https://api.github.test/user') {
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      const user = this.tokens.get(auth.replace(/^Bearer /, ''));
      if (!user) return new Response('{"message":"Bad credentials"}', { status: 401 });
      return Response.json({ id: user.id, login: user.login, name: 'Someone' });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Minimal cookie jar for driving the browser half of the flow. */
export class Jar {
  private cookies = new Map<string, string>();
  readonly raw: string[] = [];

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      this.raw.push(line);
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (!value || /Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

export function setup(opts: { config?: Partial<Config>; now?: () => number } = {}) {
  const store = new MemoryStore();
  const github = new MockGitHub();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log: Logger = (event, fields) => logs.push({ event, fields });
  const config = testConfig(opts.config);
  const app = createApp({ config, store, fetch: github.fetch, now: opts.now, log });
  const req = (path: string, init: RequestInit = {}) => app.request(`https://margin.test${path}`, init);
  return { app, store, github, logs, config, req };
}

export type Harness = ReturnType<typeof setup>;

export const LOOPBACK = 'http://127.0.0.1:53682/callback';

/**
 * GET native/start (the confirmation page), then POST its form the way a
 * browser would (cookies, same-origin Origin, the CSRF field). Returns the
 * POST response (302 to GitHub on success). Cookies are absorbed into `jar`.
 */
export async function nativeStart(h: Harness, jar: Jar, url: string, decision: 'continue' | 'cancel' = 'continue') {
  const page = await h.req(url);
  jar.absorb(page);
  if (page.status !== 200) return page;
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const res = await h.req('/api/auth/native/start', {
    method: 'POST',
    headers: { Cookie: jar.header(), Origin: 'https://margin.test', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, decision }).toString(),
  });
  jar.absorb(res);
  return res;
}

/** Drives the native flow up to the app's redirect. Returns the redirect target. */
export async function nativeAuthorize(
  h: Harness,
  user: GitHubUser = OWNER,
  opts: { redirectUri?: string; verifier?: string; appState?: string; deviceName?: string } = {},
) {
  const verifier = opts.verifier ?? newVerifier();
  const appState = opts.appState ?? b64url(randomBytes(16));
  const redirectUri = opts.redirectUri ?? LOOPBACK;
  const jar = new Jar();
  const start = await nativeStart(
    h,
    jar,
    `/api/auth/native/start?${new URLSearchParams({
      redirect_uri: redirectUri,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      state: appState,
      device_name: opts.deviceName ?? 'Test device',
    })}`,
  );
  if (start.status !== 302) return { start, jar, verifier, appState, redirectUri };
  const { code, state } = h.github.approve(start.headers.get('Location')!, user);
  const callback = await h.req(`/api/auth/github/callback?${new URLSearchParams({ code, state })}`, {
    headers: { Cookie: jar.header() },
  });
  jar.absorb(callback);
  const location = callback.headers.get('Location');
  return { start, callback, location: location ? new URL(location) : undefined, jar, verifier, appState, redirectUri, githubCode: code, githubState: state };
}

export async function exchange(h: Harness, body: Record<string, unknown>) {
  return h.req('/api/auth/native/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Full native sign-in; returns the device token. */
export async function signIn(h: Harness, deviceName = 'Test Mac'): Promise<{ token: string; deviceId: string }> {
  const a = await nativeAuthorize(h, OWNER, { deviceName });
  const res = await exchange(h, {
    code: a.location!.searchParams.get('code'),
    code_verifier: a.verifier,
    redirect_uri: a.redirectUri,
    device_name: deviceName,
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  const json = (await res.json()) as { token: string; device: { id: string } };
  return { token: json.token, deviceId: json.device.id };
}

export const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
