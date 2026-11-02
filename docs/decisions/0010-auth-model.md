# 0010. Authentication model: GitHub sign-in, allowlist, device tokens, one auth gate

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR 0011 (native redirect), ADR 0012 (token storage). Owner setup: `docs/server-setup.md`.

## Context
M5 will put the owner's documents on a server. No route may be exposed without auth, and only the owner may sign in. Margin is single-user: one GitHub account, a few devices (Mac, iPhone, maybe a browser). Clients are a desktop app (Electron) now, iOS (M6) and possibly a hosted web build (M8).

## Decision

### Server shape
- `apps/server` is a **Hono** app (`src/createApp.ts`) deployed as Vercel Functions on the **Node.js runtime with Fluid Compute** (`vercel.json` `"fluid": true`; `server.ts` exports the app for Vercel's zero-config Hono support; ADR 0014).
  - **Why Hono rather than plain `api/*.ts` functions:** one place to register a middleware that runs before *every* route (the reason for this ADR), tests that call `app.request()` with no server or Vercel CLI, typed route params, and cookie and body-limit helpers. It is one small dependency with no transitive dependencies.
  - **Local dev without a Vercel login:** `pnpm dev:server` runs the same app under `@hono/node-server` (`src/dev.ts`) with an in-memory store. `vercel dev` would also work, but it needs a login and a linked project.
- The server imports only **types** from `@margin/core` (which ships raw TS). Shared runtime constants are duplicated and checked by a test.

### Identity: GitHub OAuth (OAuth App), server-side
- **Flow:** the server redirects to GitHub with `state` and **PKCE (S256)**, then receives the code at `/api/auth/github/callback`. It exchanges the code with the client secret and its verifier, reads `GET /user` (`id`, `login`), and **drops the GitHub access token**. The token is never stored, logged or returned. No scopes are requested.
- The pending sign-in (GitHub `state`, our GitHub PKCE verifier, and the client's redirect/challenge/state) travels in a **sealed cookie**: AES-256-GCM with a key derived from `AUTH_SECRET` by HKDF. It is HttpOnly, SameSite=Lax, `Secure` + `__Host-` on https, and lasts 10 minutes. The callback deletes it whatever the outcome. **The state is also single-use on the server:** `start` records a nonce (`auth/states/<hash>.json`, 10-minute expiry) and the callback burns it with a conditional write before contacting GitHub, so a captured cookie can't be replayed, even concurrently (see Amendments).
- **Allowlist:** `ALLOWED_GITHUB_LOGINS` is a comma-separated list of `login:id` pairs, e.g. `lyonsv:1234567`.
  - Both must match: the login case-insensitively, and the immutable numeric id exactly.
  - A **recycled username** (same login, new id) is refused, and so is a **renamed account** (same id, new login) until the owner updates the variable.
  - An entry without an id fails configuration.
  - The allowlist is re-checked on **every authenticated request**, so removing an entry cuts off that user's existing devices immediately.

### Device tokens and the auth gate
- After sign-in, a client gets an opaque **device token** (ADR 0012): `mgn_<deviceId>.<secret>`, with a 256-bit secret stored only as SHA-256. It has a **rolling 90-day expiry** that is refreshed on use.
- **One gate.** `requireAuth` is registered on `*` before any route.
  - It lets through only the exact method+path pairs in `PUBLIC_ROUTES`:

    | Method and path | Purpose |
    |---|---|
    | `GET /api/auth/native/start` | Native sign-in start ("Sign in a new device?" page) |
    | `POST /api/auth/native/start` | Confirming that page (CSRF-protected) |
    | `GET /api/auth/web/start` | Web sign-in start |
    | `GET /api/auth/github/callback` | GitHub callback |
    | `POST /api/auth/native/token` | Code exchange |

  - Everything else needs a valid token, including unknown paths, so there is no route discovery. That covers routes M5 adds, which can't forget auth.
  - A test enumerates `app.routes` and asserts every non-public route returns 401 without a token.
- **Rejections are uniform:** `401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`. Missing, malformed, unknown, forged, revoked, expired and de-allowlisted tokens all look the same.
- **Comparisons:** token secrets, `state`, PKCE challenges and redirect URIs use constant-time comparison (`timingSafeEqual` over SHA-256 digests).

### Endpoints (M4)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/auth/native/start` | public | RFC 8252 start (ADR 0011): shows the confirmation page |
| `POST /api/auth/native/start` | public | Confirm (or cancel) and go to GitHub |
| `GET /api/auth/web/start?return_to=/path` | public | Hosted-web sign-in start |
| `GET /api/auth/github/callback` | public | GitHub callback |
| `POST /api/auth/native/token` | public | One-time code + PKCE verifier → device token |
| `GET /api/me` | token | `{ login, githubId, device }` |
| `GET /api/devices` | token | Live devices (never the token or its hash) |
| `DELETE /api/devices/:id` | token | Revoke a device (204, or 404) |
| `POST /api/auth/signout` | token | Revoke the calling device |

### Hosted web build: cookie session (server side done)
- `/api/auth/web/start` runs the same GitHub flow and, at the callback, creates a `web` device and sets its token as a cookie.
  - The cookie is `__Host-margin_session`, HttpOnly, Secure, SameSite=Lax, `Path=/`, and lives 90 days.
  - `requireAuth` accepts the bearer header **or** this cookie.
- **CSRF:** cookie-authenticated non-GET requests must carry `Origin` equal to `PUBLIC_URL`. SameSite=Lax already withholds the cookie on cross-site POST/DELETE.
- `return_to` must be a same-origin path. Doubtful values fall back to `/`: absolute and scheme-relative URLs, `//` anywhere in the path, backslashes, dot segments, percent-encoded dots, slashes or backslashes, fragments, control characters, and anything URL parsing would rewrite. The value emitted is checked, not just the input (see Amendments).
- **Not done (M8):** serving the static web export *behind* this cookie, and a sign-in screen in the browser build. Hosting the web build is an M8 task, and it must route the static files through the same gate (e.g. a Hono static handler after `requireAuth`, or Vercel Routing Middleware that checks the cookie against the same store).

### Hygiene
- **Rate limits** are in memory, per instance, fixed 10-minute windows per client IP (`x-real-ip`/`x-forwarded-for`, which Vercel sets):

  | Endpoint | Limit per window |
  |---|---|
  | start | 30 |
  | callback | 30 |
  | token exchange | 20 |
  | failed auth (401s) | 100 |

  **Limitation:** each Fluid Compute instance counts separately and resets on cold start. Use Vercel Firewall rules for a hard limit. Codes and tokens are 256-bit, so this is abuse damping, not the security boundary.
- **No open redirects:** the server only redirects to GitHub (built from config), an allowlisted native redirect (ADR 0011), or a same-origin path from `safeReturnPath`. A bad native redirect target gets a 400 page, never a redirect; a bad `return_to` becomes `/`.
- **Logging:** structured events only (`signin.denied`, `token.issued`…), with GitHub ids but never tokens, codes, `state` or GitHub tokens. A test greps the logs. Don't add Hono's `logger()` middleware: it logs URLs, and callback URLs carry codes.
- **Headers:** every response gets these.

  | Header | Value |
  |---|---|
  | `Cache-Control` | `no-store` |
  | `X-Content-Type-Options` | `nosniff` |
  | `Referrer-Policy` | `no-referrer` |
  | `X-Frame-Options` | `DENY` |
  | `Content-Security-Policy` | `default-src 'none'` |

  The HTML pages reflect nothing from the request.
- **Fail closed:** configuration is parsed on first request. Anything missing or malformed returns a generic 500 for every request, never an unauthenticated server. On Vercel, `MARGIN_STORE=memory` is refused.

## Consequences
- M5 adds routes to the same Hono app and gets auth for free. It must keep its blob keys out of `auth/` (ADR 0012).
- Adding a second person means adding a `login:id` pair. There are no roles; every allowlisted user sees only their own devices, but M5 must still scope data per GitHub id if that ever matters.
- GitHub is the only identity provider. If GitHub is down, existing devices keep working; only new sign-ins fail.
- Not verified against real GitHub or a real Vercel deployment (M4 was local-only by brief). In particular, GitHub's PKCE support for OAuth Apps and Vercel's Hono zero-config detection in this monorepo should be confirmed on the first deploy (M8, `docs/server-setup.md`).

## Amendments (2026-11-02, after the M4 security review of 34c08ae)
- **Open redirect fixed.** As first written, `safeReturnPath` validated the raw `return_to` but returned the URL-normalised pathname, so `/..//evil.com` (also `/.%2E//evil.com` and `/%2e%2e//evil.com`) produced `Location: //evil.com`. The claim above that this couldn't happen was wrong. It now refuses dot segments, encoded dots, slashes and backslashes, and `//`, and requires that the emitted value equals the input and is a same-origin path. Tests cover the reported payloads, plus a 18⁴-case corpus asserting the output is always a same-origin path that browsers won't re-normalise.
- **State replay closed.** Deleting the cookie only made `state` single-use in the browser that deleted it; a captured sealed cookie could be replayed for its 10-minute life. `NonceRepository` (`src/nonces.ts`) now burns the state server-side at the callback (mark-used with `ifMatch`, as for codes). Expired nonces are swept at successful callbacks. Each `start` costs one Blob write, and `start` is rate-limited per instance.
- **Native start asks first.** `GET /api/auth/native/start` no longer redirects straight to GitHub (which skips its consent screen for an app you've already authorised, so a crafted link could sign in a device silently). It shows "Sign in a new device '<name>'?" (name HTML-escaped). The validated request waits in a sealed `margin_confirm` cookie; **Continue** POSTs back with a CSRF token that must match the cookie, and the POST must carry `Origin` = `PUBLIC_URL`. **Cancel** returns `error=access_denied` to the app. The confirmed name is stored with the one-time code and becomes the device's name. `POST /api/auth/native/start` joins `PUBLIC_ROUTES`. The custom scheme is disabled until M6 (ADR 0011).
- **Web cookie rolls.** The session cookie used to keep its original 90-day `Max-Age` while the server-side expiry rolled, so browsers dropped a session that was still valid. When a cookie-authenticated request rolls the expiry (at most hourly), the response re-issues the cookie with `Max-Age` = the new remaining lifetime.
- **Body limits per route.** A global middleware applies `ROUTE_BODY_LIMITS["METHOD /pattern"]` (from the matched route, before auth): 0 for GETs and `DELETE /api/devices/:id`, 1–8 KiB for the auth POSTs; unknown paths get 1 KiB. A test fails if a registered route has no entry, so every new route (M5) must choose its limit explicitly.
- **Confirm page single-use (validator M5, MINOR 3).** The `margin_confirm` cookie was only single-use in the browser that deleted it. `GET native/start` now also records a server-side nonce for its CSRF token (`auth/confirms/`), and the POST burns it with the same conditional write as OAuth state, so a captured cookie and token can't be replayed, even concurrently.
