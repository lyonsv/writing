import type { DeviceInfo, MeResponse, NativeTokenResponse } from '@margin/core';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';

import { CodeRepository } from './codes.js';
import { StoreBusyError } from './store.js';
import { UsedSet } from './usedSet.js';
import { MAX_DOCUMENT_BYTES, SyncConflictError, SyncLimitError, SyncRepository, type Precondition, type SyncEntry } from './sync.js';
import { isSyncPath } from './syncPaths.js';
import { ConfigError, isAllowed, type Config } from './config.js';
import { PKCE_CHALLENGE, PKCE_VERIFIER, Pepper, Sealer, pkceChallenge, randomToken, safeEqual } from './crypto.js';
import { DeviceRepository, TOKEN_TTL_MS, cleanDeviceName, toDeviceInfo, type DeviceRecord, type Identity } from './devices.js';
import { GitHubError, authorizeUrl, fetchGitHubIdentity, type Fetch } from './github.js';
import { RateLimiter } from './rateLimit.js';
import { CUSTOM_SCHEME_REDIRECT, isAllowedNativeRedirect, safeReturnPath } from './redirects.js';
import type { KeyValueStore } from './store.js';

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
  'POST /api/auth/native/start',
  'GET /api/auth/web/start',
  'GET /api/auth/github/callback',
  'POST /api/auth/native/token',
]);

/**
 * Request body limit for every route, in bytes, keyed like `app.routes`
 * (`METHOD /pattern`). A test fails if a registered route is missing here, so
 * each new route (M5) has to pick its limit. Unknown paths get DEFAULT_BODY_LIMIT.
 * Vercel caps request bodies at 4.5 MB regardless.
 */
export const DEFAULT_BODY_LIMIT = 1024;
export const ROUTE_BODY_LIMITS: Readonly<Record<string, number>> = {
  'GET /api/auth/native/start': 0,
  'POST /api/auth/native/start': 2 * 1024,
  'GET /api/auth/web/start': 0,
  'GET *': 0,
  'GET /api/auth/github/callback': 0,
  'POST /api/auth/native/token': 8 * 1024,
  'GET /api/me': 0,
  'GET /api/devices': 0,
  'DELETE /api/devices/:id': 0,
  'POST /api/auth/signout': 1024,
  // Sync (ADR 0013). Documents over 4 MiB are refused (Vercel's body limit is 4.5 MB).
  'GET /api/sync/manifest': 0,
  'GET /api/sync/file': 0,
  'PUT /api/sync/file': MAX_DOCUMENT_BYTES,
  'DELETE /api/sync/file': 0,
  'POST /api/sync/move': 4 * 1024,
};

/** `"12"`, `W/"12"` or `12` → `12`. */
const revFrom = (header: string | undefined): string | undefined => header?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1') || undefined;

export type Logger = (event: string, fields?: Record<string, string | number | boolean>) => void;

export interface AppDeps {
  /** A config, or a loader that may throw `ConfigError` (then every request gets a generic 500). */
  config: Config | (() => Config);
  store: KeyValueStore;
  fetch?: Fetch;
  now?: () => number;
  /** Structured log sink. Never receives tokens, codes, state or GitHub tokens. */
  log?: Logger;
  /**
   * The hosted web app (ADR 0020). `shell` returns the app's index.html (null
   * if there's no web build). `asset` serves static files for local dev and
   * tests; on Vercel the CDN serves them from `public/` and never reaches here.
   */
  web?: {
    shell: () => Promise<string | null>;
    asset?: (pathname: string) => Promise<WebAsset | null>;
  };
}

export interface WebAsset {
  body: Uint8Array;
  type: string;
  /** Content-hashed name: cache for a year. */
  immutable: boolean;
}

/**
 * The signed-in app shell's CSP: our own scripts only; inline styles for
 * react-native-web and CodeMirror; same-origin API calls; our service worker.
 */
export const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
  /** native: device name the user confirmed. */
  dn?: string;
  /** web: same-origin path to land on. */
  rt?: string;
}

/** The native start request awaiting the user's confirmation (sealed cookie). */
interface PendingConfirm {
  ru: string;
  cc: string;
  cs: string;
  dn: string;
  csrf: string;
  exp: number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

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

  let config: Config | undefined;
  let sealer: Sealer | undefined;
  // Built with the config: their hashes are keyed by AUTH_SECRET.
  let devices!: DeviceRepository;
  let codes!: CodeRepository;
  /** Single-use marks for OAuth state, confirm tokens and codes (one record; ADR 0021). */
  let used!: UsedSet;
  const getConfig = (): Config => {
    if (!config) {
      config = typeof deps.config === 'function' ? deps.config() : deps.config;
      sealer = new Sealer(config.authSecret);
      const pepper = new Pepper(config.authSecret);
      devices = new DeviceRepository(deps.store, pepper, now);
      used = new UsedSet(deps.store, pepper.hash, now);
      codes = new CodeRepository(new Sealer(config.authSecret, 'one-time-code v1'), used, now);
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
    return { session: `${prefix}margin_session`, oauth: `${prefix}margin_oauth`, confirm: `${prefix}margin_confirm` };
  };
  const cookieBase = () => ({ path: '/', httpOnly: true, secure: getConfig().secureCookies, sameSite: 'Lax' as const });

  const app = new Hono<Env>();

  // --- Hardening for every response.
  app.use('*', async (c, next) => {
    getConfig(); // fail closed before doing anything
    await next();
    // Static files set their own caching (dev/test only; the CDN serves them on Vercel).
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
  });

  // --- Body limits, per route (before anything reads a body).
  app.use('*', async (c, next) => {
    const route = matchedRoutes(c).filter((r) => r.method !== 'ALL').pop();
    const maxSize = route ? (ROUTE_BODY_LIMITS[`${route.method} ${route.path}`] ?? DEFAULT_BODY_LIMIT) : DEFAULT_BODY_LIMIT;
    return bodyLimit({ maxSize, onError: (cx) => cx.json({ error: 'payload_too_large' }, 413) })(c, next);
  });

  // --- Static files of the web app (local dev and tests only; public, no user data).
  if (deps.web?.asset) {
    const asset = deps.web.asset;
    app.use('*', async (c, next) => {
      if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || c.req.path.startsWith('/api/')) return next();
      const file = await asset(c.req.path);
      if (!file) return next();
      return c.body(file.body as unknown as ArrayBuffer, 200, {
        'Content-Type': file.type,
        'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        // A service worker's own fetches obey its CSP: let it reach this origin.
        ...(c.req.path === '/sw.js' ? { 'Content-Security-Policy': "default-src 'self'" } : {}),
      });
    });
  }

  // --- The one auth gate. Deny by default.
  const unauthorized = (c: Context) => {
    if (!limits.failedAuth.hit(clientIp(c))) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '600' });
    // A signed-out visit to the web app gets the sign-in page (still a 401), not JSON.
    if (deps.web && (c.req.method === 'GET' || c.req.method === 'HEAD') && !c.req.path.startsWith('/api/')) return signInPage(c);
    return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  };

  /** Minimal sign-in page for the hosted web app (ADR 0020): one link into the web OAuth flow. */
  const signInPage = (c: Context) => {
    const back = safeReturnPath(c.req.path, getConfig().publicUrl);
    const start = `/api/auth/web/start?return_to=${encodeURIComponent(back)}`;
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
        `<title>Margin</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
        `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Margin">` +
        `<meta name="theme-color" content="#fbfbfa"><meta name="robots" content="noindex">` +
        `<body style="margin:0;font:17px/1.5 -apple-system,system-ui,sans-serif;background:#fbfbfa;color:#1f1f1f">` +
        `<main id="margin-signin" style="max-width:26rem;margin:0 auto;padding:22vh 1.5rem 2rem">` +
        `<img src="/apple-touch-icon.png" width="64" height="64" alt="" style="border-radius:14px">` +
        `<h1 style="font-size:1.4rem;margin:1rem 0 .25rem">Margin</h1>` +
        `<p style="color:#6b6b68;margin:0 0 1.5rem">A quiet place to write. Sign in to open your library.</p>` +
        `<a id="margin-signin-link" href="${escapeHtml(start)}" style="display:inline-block;padding:.7rem 1.1rem;border-radius:10px;background:#1f1f1f;color:#fbfbfa;text-decoration:none">Sign in with GitHub</a>` +
        `</main></body></html>`,
      401,
    );
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
    const auth = await devices.authenticateAndTouch(token);
    const device = auth?.record;
    // The allowlist is re-checked on every request: removing someone from
    // ALLOWED_GITHUB_LOGINS cuts off their existing devices immediately.
    if (!auth || !device || !isAllowed(cfg.allowedUsers, device.login, device.githubId)) return unauthorized(c);
    // Web sessions roll like device tokens: when the expiry moves, so does the cookie's Max-Age.
    if (via === 'cookie' && auth.touched) {
      const maxAge = Math.max(0, Math.floor((device.expiresAt - now()) / 1000));
      setCookie(c, cookieNames().session, token, { ...cookieBase(), maxAge });
    }
    c.set('device', device);
    c.set('via', via);
    await next();
  };
  app.use('*', requireAuth);

  // --- Sign-in (public).

  const startGitHub = async (c: Context, pending: Omit<PendingSignIn, 's' | 'v' | 'exp'>) => {
    const cfg = getConfig();
    const s = randomToken(32);
    // Single use is enforced at the callback (UsedSet), not by storing anything now.
    const v = randomToken(48);
    const sealed = sealer!.seal({ ...pending, s, v, exp: now() + OAUTH_COOKIE_TTL_S * 1000 } satisfies PendingSignIn);
    setCookie(c, cookieNames().oauth, sealed, { ...cookieBase(), maxAge: OAUTH_COOKIE_TTL_S });
    return c.redirect(authorizeUrl(cfg, s, pkceChallenge(v)), 302);
  };

  /**
   * RFC 8252 native start: the app opened the system browser here. We don't go
   * straight to GitHub (which skips its consent screen for an app you already
   * authorised): the user first confirms "Sign in a new device '<name>'?" on our
   * own page. The validated request waits in a sealed cookie; the form carries a
   * CSRF token that must match it, and the POST must come from our own origin.
   */
  app.get('/api/auth/native/start', limited('start'), async (c) => {
    const q = c.req.query();
    const ru = q.redirect_uri ?? '';
    const cc = q.code_challenge ?? '';
    const cs = q.state ?? '';
    const allowCustomScheme = getConfig().allowNativeSchemeRedirect === true;
    if (
      !isAllowedNativeRedirect(ru, { allowCustomScheme }) ||
      !PKCE_CHALLENGE.test(cc) ||
      q.code_challenge_method !== 'S256' ||
      !STATE.test(cs)
    ) {
      log('signin.bad_start');
      return page(c, 400, 'Invalid sign-in request', 'Start signing in again from the Margin app.');
    }
    // Defence in depth for the custom scheme: an app opens this URL itself (Sec-Fetch-Site
    // "none" or absent); a link or redirect from another site is refused.
    const site = c.req.header('Sec-Fetch-Site');
    if (ru === CUSTOM_SCHEME_REDIRECT && site !== undefined && site !== 'none') {
      log('signin.bad_start');
      return page(c, 400, 'Invalid sign-in request', 'Sign-in must be started from the Margin app, not from a web page.');
    }
    const client =
      ru === CUSTOM_SCHEME_REDIRECT
        ? 'an iPhone app (development build, returning to margin://)'
        : 'a Mac app (Margin on this computer, returning to 127.0.0.1)';
    const dn = cleanDeviceName(q.device_name);
    const csrf = randomToken(24);
    // Single use is enforced at the POST (UsedSet), so a captured confirm cookie can't be replayed.
    const sealed = sealer!.seal({ ru, cc, cs, dn, csrf, exp: now() + OAUTH_COOKIE_TTL_S * 1000 } satisfies PendingConfirm);
    setCookie(c, cookieNames().confirm, sealed, { ...cookieBase(), maxAge: OAUTH_COOKIE_TTL_S });
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const name = escapeHtml(dn);
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in a new device?</title>` +
        `<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
        `<h1 style="font-size:1.2rem">Sign in a new device “${name}”?</h1>` +
        `<p>Requested by ${escapeHtml(client)}. That device will be able to read and change your synced documents.</p>` +
        `<p><strong>Only continue if you just chose Sign In in Margin yourself.</strong> If this page opened from a link, an email or another website, press Cancel.</p>` +
        `<form id="margin-confirm" method="post" action="/api/auth/native/start">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<button type="submit" name="decision" value="continue">Continue to GitHub</button> ` +
        `<button type="submit" name="decision" value="cancel">Cancel</button></form></body>`,
      200,
    );
  });

  app.post('/api/auth/native/start', limited('start'), async (c) => {
    const cfg = getConfig();
    const names = cookieNames();
    const raw = getCookie(c, names.confirm);
    deleteCookie(c, names.confirm, cookieBase());
    const pending = raw ? (sealer!.unseal(raw) as PendingConfirm | null) : null;
    let form: Record<string, unknown> = {};
    try {
      form = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      /* treated as missing below */
    }
    const csrf = typeof form.csrf === 'string' ? form.csrf : '';
    if (
      !pending ||
      typeof pending.csrf !== 'string' ||
      pending.exp <= now() ||
      c.req.header('Origin') !== cfg.publicUrl.origin ||
      !safeEqual(pending.csrf, csrf) ||
      !isAllowedNativeRedirect(pending.ru, { allowCustomScheme: cfg.allowNativeSchemeRedirect === true }) ||
      !(await used.use(`confirm:${pending.csrf}`, pending.exp))
    ) {
      log('signin.bad_confirm');
      return page(c, 400, 'Sign-in expired', 'This sign-in page has expired or was already used. Start again from the app.');
    }
    if (form.decision !== 'continue') {
      const back = new URL(pending.ru);
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', pending.cs);
      return c.redirect(back.toString(), 302);
    }
    return startGitHub(c, { flow: 'native', ru: pending.ru, cc: pending.cc, cs: pending.cs, dn: pending.dn });
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
    if (
      !pending ||
      typeof pending.s !== 'string' ||
      pending.exp <= now() ||
      !safeEqual(pending.s, state) ||
      !(await used.use(`state:${pending.s}`, pending.exp))
    ) {
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
      const oneTime = await codes.issue(identity, pending.cc!, pending.ru!, pending.dn);
      log('signin.code_issued', { githubId: identity.githubId });
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
  app.post('/api/auth/native/token', limited('token'), async (c) => {
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
    // The name the user confirmed on our page wins over whatever the client sends now.
    const { token, record } = await devices.create(result.identity, result.deviceName ?? (typeof name === 'string' ? name : ''), 'native');
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

  // --- Sync (ADR 0013). All behind requireAuth like everything else.
  const sync = new SyncRepository(deps.store, now);

  const syncError = (c: Context, error: unknown) => {
    if (error instanceof SyncConflictError) {
      return error.kind === 'precondition'
        ? c.json({ error: 'precondition_failed', current: error.current }, 412)
        : c.json({ error: 'path_conflict', path: error.conflictingPath ?? null }, 409);
    }
    if (error instanceof SyncLimitError) return c.json({ error: 'too_large', message: error.message }, 413);
    throw error;
  };
  const pathParam = (c: Context): string | null => {
    const p = c.req.query('path');
    return isSyncPath(p) ? p : null;
  };

  app.get('/api/sync/manifest', async (c) => {
    const m = await sync.manifest();
    const etag = `"m${m.seq}"`;
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, { ETag: etag });
    return c.json({ seq: m.seq, entries: m.entries }, 200, { ETag: etag });
  });

  app.get('/api/sync/file', async (c) => {
    const path = pathParam(c);
    if (!path) return c.json({ error: 'invalid_path' }, 400);
    const got = await sync.get(path);
    if (!got) return c.json({ error: 'not_found' }, 404);
    return c.body(got.bytes as unknown as ArrayBuffer, 200, {
      'Content-Type': 'application/octet-stream',
      ETag: `"${got.entry.rev}"`,
      'X-Margin-Entry': encodeURIComponent(JSON.stringify(got.entry)),
    });
  });

  app.put('/api/sync/file', async (c) => {
    const path = pathParam(c);
    if (!path) return c.json({ error: 'invalid_path' }, 400);
    const ifMatch = revFrom(c.req.header('If-Match'));
    const ifNoneMatch = c.req.header('If-None-Match')?.trim();
    let pre: Precondition;
    if (ifMatch && !ifNoneMatch) pre = { ifMatch };
    else if (ifNoneMatch === '*' && !ifMatch) pre = { ifNoneMatch: true };
    else return c.json({ error: 'precondition_required' }, 428); // never a blind overwrite
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const entry: SyncEntry = await sync.put(path, bytes, pre);
      return c.json({ entry }, 200, { ETag: `"${entry.rev}"` });
    } catch (error) {
      return syncError(c, error);
    }
  });

  app.delete('/api/sync/file', async (c) => {
    const path = pathParam(c);
    if (!path) return c.json({ error: 'invalid_path' }, 400);
    const ifMatch = revFrom(c.req.header('If-Match'));
    if (!ifMatch) return c.json({ error: 'precondition_required' }, 428);
    try {
      return c.json({ entry: await sync.delete(path, ifMatch) });
    } catch (error) {
      return syncError(c, error);
    }
  });

  app.post('/api/sync/move', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const { from, to, ifMatch } = body ?? {};
    if (!isSyncPath(from) || !isSyncPath(to) || typeof ifMatch !== 'string' || !ifMatch) return c.json({ error: 'invalid_request' }, 400);
    try {
      return c.json({ entry: await sync.move(from, to, ifMatch) });
    } catch (error) {
      return syncError(c, error);
    }
  });

  // --- The web app shell (ADR 0020): any other page, signed in only (requireAuth ran above).
  if (deps.web) {
    const shell = deps.web.shell;
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
      const html = await shell();
      if (!html) return c.json({ error: 'not_found' }, 404);
      c.header('Content-Security-Policy', SHELL_CSP);
      c.header('X-Margin-Shell', '1'); // the service worker caches only this, for offline launches
      return c.html(html.replace('<head>', '<head><meta name="margin-hosted" content="1">'));
    });
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500) return c.json({ error: 'invalid_request' }, error.status);
    if (error instanceof StoreBusyError) {
      // The storage backend (GitHub) is rate-limiting us: tell clients when to come back.
      log('store.busy', { retryAfter: error.retryAfterSeconds });
      return c.json({ error: 'busy' }, 503, { 'Retry-After': String(error.retryAfterSeconds), 'Cache-Control': 'no-store' });
    }
    if (error instanceof ConfigError) log('config.error', { message: error.message });
    else log('server.error', { name: error.name, message: error.message.slice(0, 200) });
    // Errors can be raised before the hardening middleware runs (e.g. config): set its headers here too.
    return c.json({ error: 'server_error' }, 500, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });

  return app;
}
