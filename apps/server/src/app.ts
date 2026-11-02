import type { DeviceInfo, MeResponse, NativeTokenResponse } from '@margin/core';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';

import { CodeRepository } from './codes';
import { ConfigError, isAllowed, type Config } from './config';
import { PKCE_CHALLENGE, PKCE_VERIFIER, Sealer, pkceChallenge, randomToken, safeEqual } from './crypto';
import { DeviceRepository, TOKEN_TTL_MS, toDeviceInfo, type DeviceRecord, type Identity } from './devices';
import { GitHubError, authorizeUrl, fetchGitHubIdentity, type Fetch } from './github';
import { RateLimiter } from './rateLimit';
import { isAllowedNativeRedirect, safeReturnPath } from './redirects';
import type { KeyValueStore } from './store';

/**
 * The Margin API. See docs/decisions/0010-auth-model.md.
 *
 * Every request passes through `requireAuth` (registered on `*`), which lets
 * through only the exact method+path pairs in PUBLIC_ROUTES. Anything else,
 * including routes added later and paths that don't exist, needs a valid,
 * unrevoked, unexpired token, so a new M5 route can't forget auth.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/auth/native/start',
  'GET /api/auth/web/start',
  'GET /api/auth/github/callback',
  'POST /api/auth/native/token',
]);

export type Logger = (event: string, fields?: Record<string, string | number | boolean>) => void;

export interface AppDeps {
  /** A config, or a loader that may throw `ConfigError` (then every request gets a generic 500). */
  config: Config | (() => Config);
  store: KeyValueStore;
  fetch?: Fetch;
  now?: () => number;
  /** Structured log sink. Never receives tokens, codes, state or GitHub tokens. */
  log?: Logger;
}

type Env = { Variables: { device: DeviceRecord; via: 'bearer' | 'cookie' } };

const OAUTH_COOKIE_TTL_S = 10 * 60;
const STATE = /^[A-Za-z0-9\-._~]{16,256}$/;

interface PendingSignIn {
  /** State we sent to GitHub. */
  s: string;
  /** Our PKCE verifier for GitHub. */
  v: string;
  exp: number;
  flow: 'native' | 'web';
  /** native: the app's redirect URI, S256 challenge and state. */
  ru?: string;
  cc?: string;
  cs?: string;
  /** web: same-origin path to land on. */
  rt?: string;
}

function clientIp(c: Context): string {
  return c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

function page(c: Context, status: 400 | 403 | 429 | 500 | 502, title: string, body: string): Response {
  // Static text only: nothing from the request is reflected into the page.
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
      `<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
      `<h1 style="font-size:1.2rem">${title}</h1><p>${body}</p></body>`,
    status,
  );
}

export function createApp(deps: AppDeps): Hono<Env> {
  const now = deps.now ?? Date.now;
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const log: Logger = deps.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
  const devices = new DeviceRepository(deps.store, now);
  const codes = new CodeRepository(deps.store, now);

  let config: Config | undefined;
  let sealer: Sealer | undefined;
  const getConfig = (): Config => {
    if (!config) {
      config = typeof deps.config === 'function' ? deps.config() : deps.config;
      sealer = new Sealer(config.authSecret);
    }
    return config;
  };

  const tenMinutes = 10 * 60 * 1000;
  const limits = {
    start: new RateLimiter(30, tenMinutes, now),
    callback: new RateLimiter(30, tenMinutes, now),
    token: new RateLimiter(20, tenMinutes, now),
    failedAuth: new RateLimiter(100, tenMinutes, now),
  };
  const limited = (bucket: keyof typeof limits): MiddlewareHandler<Env> => async (c, next) => {
    if (!limits[bucket].hit(clientIp(c))) {
      log('ratelimit', { bucket });
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' });
    }
    await next();
  };

  const cookieNames = () => {
    const prefix = getConfig().secureCookies ? '__Host-' : '';
    return { session: `${prefix}margin_session`, oauth: `${prefix}margin_oauth` };
  };
  const cookieBase = () => ({ path: '/', httpOnly: true, secure: getConfig().secureCookies, sameSite: 'Lax' as const });

  const app = new Hono<Env>();

  // --- Hardening for every response.
  app.use('*', async (c, next) => {
    getConfig(); // fail closed before doing anything
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
  });

  // --- The one auth gate. Deny by default.
  const unauthorized = (c: Context) => {
    if (!limits.failedAuth.hit(clientIp(c))) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' });
    return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  };

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    if (PUBLIC_ROUTES.has(`${c.req.method} ${c.req.path}`)) return next();
    const cfg = getConfig();
    const header = c.req.header('Authorization');
    let token: string | undefined;
    let via: 'bearer' | 'cookie';
    if (header !== undefined) {
      const m = /^Bearer ([^\s]+)$/.exec(header);
      if (!m) return unauthorized(c);
      token = m[1];
      via = 'bearer';
    } else {
      token = getCookie(c, cookieNames().session);
      via = 'cookie';
      // CSRF: cookie-authenticated writes must come from our own origin.
      // (SameSite=Lax already withholds the cookie on cross-site POST/DELETE.)
      if (token && c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('Origin') !== cfg.publicUrl.origin) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    if (!token) return unauthorized(c);
    const device = await devices.authenticate(token);
    // The allowlist is re-checked on every request: removing someone from
    // ALLOWED_GITHUB_LOGINS cuts off their existing devices immediately.
    if (!device || !isAllowed(cfg.allowedUsers, device.login, device.githubId)) return unauthorized(c);
    c.set('device', device);
    c.set('via', via);
    await next();
  };
  app.use('*', requireAuth);

  // --- Sign-in (public).

  const startGitHub = (c: Context, pending: Omit<PendingSignIn, 's' | 'v' | 'exp'>) => {
    const cfg = getConfig();
    const s = randomToken(32);
    const v = randomToken(48);
    const sealed = sealer!.seal({ ...pending, s, v, exp: now() + OAUTH_COOKIE_TTL_S * 1000 } satisfies PendingSignIn);
    setCookie(c, cookieNames().oauth, sealed, { ...cookieBase(), maxAge: OAUTH_COOKIE_TTL_S });
    return c.redirect(authorizeUrl(cfg, s, pkceChallenge(v)), 302);
  };

  /** RFC 8252 native start: the app opened the system browser here. */
  app.get('/api/auth/native/start', limited('start'), (c) => {
    const q = c.req.query();
    const ru = q.redirect_uri ?? '';
    const cc = q.code_challenge ?? '';
    const cs = q.state ?? '';
    if (!isAllowedNativeRedirect(ru) || !PKCE_CHALLENGE.test(cc) || q.code_challenge_method !== 'S256' || !STATE.test(cs)) {
      log('signin.bad_start');
      return page(c, 400, 'Invalid sign-in request', 'Start signing in again from the Margin app.');
    }
    return startGitHub(c, { flow: 'native', ru, cc, cs });
  });

  /** Hosted web build: cookie session (ADR 0010). */
  app.get('/api/auth/web/start', limited('start'), (c) =>
    startGitHub(c, { flow: 'web', rt: safeReturnPath(c.req.query('return_to'), getConfig().publicUrl) }),
  );

  app.get('/api/auth/github/callback', limited('callback'), async (c) => {
    const cfg = getConfig();
    const names = cookieNames();
    const raw = getCookie(c, names.oauth);
    // The pending sign-in is single-use whatever happens next.
    deleteCookie(c, names.oauth, cookieBase());
    const pending = raw ? (sealer!.unseal(raw) as PendingSignIn | null) : null;
    const state = c.req.query('state') ?? '';
    if (!pending || typeof pending.s !== 'string' || pending.exp <= now() || !safeEqual(pending.s, state)) {
      log('signin.bad_state');
      return page(c, 400, 'Sign-in expired', 'This sign-in link has expired or was already used. Start again from the app.');
    }

    // Native errors go back to the app (its redirect was validated at start), so it stops waiting.
    const backToApp = (params: Record<string, string>) => {
      const target = new URL(pending.ru!);
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      target.searchParams.set('state', pending.cs!);
      return c.redirect(target.toString(), 302);
    };
    const fail = (error: 'access_denied' | 'server_error', status: 403 | 502, title: string, body: string) =>
      pending.flow === 'native' ? backToApp({ error }) : page(c, status, title, body);

    const code = c.req.query('code');
    if (c.req.query('error') || !code) {
      log('signin.cancelled');
      return fail('access_denied', 403, 'Sign-in cancelled', 'GitHub sign-in was cancelled.');
    }

    let identity: Identity;
    try {
      identity = await fetchGitHubIdentity(cfg, fetchImpl, code, pending.v);
    } catch (error) {
      log('signin.github_failed', { reason: error instanceof GitHubError ? error.message : 'network' });
      return fail('server_error', 502, 'Sign-in failed', 'GitHub could not be reached. Try again.');
    }
    if (!isAllowed(cfg.allowedUsers, identity.login, identity.githubId)) {
      log('signin.denied', { githubId: identity.githubId });
      return fail('access_denied', 403, 'Not allowed', 'This GitHub account is not allowed to use this Margin server.');
    }

    if (pending.flow === 'native') {
      const oneTime = await codes.issue(identity, pending.cc!, pending.ru!);
      log('signin.code_issued', { githubId: identity.githubId });
      await codes.sweep().catch(() => undefined);
      return backToApp({ code: oneTime });
    }
    const ua = c.req.header('User-Agent') ?? '';
    const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const { token } = await devices.create(identity, `Web (${browser})`, 'web');
    setCookie(c, names.session, token, { ...cookieBase(), maxAge: Math.floor(TOKEN_TTL_MS / 1000) });
    log('signin.web_session', { githubId: identity.githubId });
    return c.redirect(pending.rt ?? '/', 302);
  });

  /** Native step 3: one-time code + PKCE verifier → device token. */
  app.post('/api/auth/native/token', limited('token'), bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const cfg = getConfig();
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const { code, code_verifier: verifier, redirect_uri: ru, device_name: name } = body ?? {};
    if (typeof code !== 'string' || typeof verifier !== 'string' || typeof ru !== 'string' || !PKCE_VERIFIER.test(verifier)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const result = await codes.redeem(code, verifier, ru);
    if (!result.ok || !isAllowed(cfg.allowedUsers, result.identity.login, result.identity.githubId)) {
      log('token.invalid_grant');
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const { token, record } = await devices.create(result.identity, typeof name === 'string' ? name : '', 'native');
    log('token.issued', { githubId: record.githubId });
    return c.json({ token, login: record.login, device: toDeviceInfo(record, record.id) } satisfies NativeTokenResponse);
  });

  // --- Authenticated routes (requireAuth already ran).

  app.get('/api/me', (c) => {
    const d = c.get('device');
    return c.json({ login: d.login, githubId: d.githubId, device: toDeviceInfo(d, d.id) } satisfies MeResponse);
  });

  app.get('/api/devices', async (c) => {
    const d = c.get('device');
    const list = await devices.list(d);
    return c.json({ devices: list.map((r) => toDeviceInfo(r, d.id)) satisfies DeviceInfo[] });
  });

  const endSessionCookie = (c: Context<Env>) => {
    if (c.get('via') === 'cookie') deleteCookie(c, cookieNames().session, cookieBase());
  };

  app.delete('/api/devices/:id', async (c) => {
    const d = c.get('device');
    const id = c.req.param('id');
    if (!(await devices.revoke(d, id))) return c.json({ error: 'not_found' }, 404);
    log('device.revoked', { self: id === d.id });
    if (id === d.id) endSessionCookie(c);
    return c.body(null, 204);
  });

  app.post('/api/auth/signout', async (c) => {
    const d = c.get('device');
    await devices.revoke(d, d.id);
    endSessionCookie(c);
    log('device.signed_out');
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500) return c.json({ error: 'invalid_request' }, error.status);
    if (error instanceof ConfigError) log('config.error', { message: error.message });
    else log('server.error', { name: error.name, message: error.message.slice(0, 200) });
    return c.json({ error: 'server_error' }, 500);
  });

  return app;
}
