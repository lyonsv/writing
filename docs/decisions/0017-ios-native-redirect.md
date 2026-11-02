# 0017. iOS sign-in: `margin://auth/callback` through ASWebAuthenticationSession

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR 0010 (auth model), 0011 (native redirect; this ADR enables its iOS half), 0012 (token storage).

## Context
ADR 0011 chose the private-use scheme `margin://auth/callback` for iOS and kept it disabled on the server until an app registered it (`CUSTOM_SCHEME_ENABLED = false`), because any app can claim a custom scheme. M6 ships that app. Development uses Expo Go, whose own scheme is `exp://`.

## Decision
- **Server:** `CUSTOM_SCHEME_ENABLED = true`. The exact string `margin://auth/callback` is accepted (no query, fragment, case or path variants; tests cover them). Everything else in ADR 0010/0011 is unchanged: PKCE S256 bound to the code, `state`, one-time 60 s codes, and the **"Sign in a new device '<name>'?" confirmation page** (single-use, CSRF-protected) before GitHub. This is live in production since the orchestrator's deploy of d04f4f4.
- **App** (`apps/app/src/native/account.ts`, wired in `services.ts`): `WebBrowser.openAuthSessionAsync(start, 'margin://auth/callback')`, which is `ASWebAuthenticationSession` on iOS. A 256-bit verifier, S256 challenge and 192-bit state come from `expo-crypto`. The app checks `state` (constant time) and the callback prefix, then POSTs the code and verifier to `/api/auth/native/token` (`redirect: 'error'`). The token is stored with `expo-secure-store` as `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: not in iCloud Keychain, and not restored to another phone. It's never written to a file, and it's only sent to the server it was issued by (changing the server URL makes the app signed out for the new one). A 401 forgets it.
- **Scheme registration:** `app.json` keeps `"scheme": "margin"` (`CFBundleURLTypes` in builds) and `ios.bundleIdentifier` `com.lyonsv.margin`.
- **Expo Go needs no `exp://` entry.** `ASWebAuthenticationSession` watches for its `callbackURLScheme` inside the session itself and completes when the server redirects to `margin://…`, whether or not any app has registered the scheme. So Expo Go can use the same production redirect, and no development-only redirect goes into the allowlist. (Apple documents this; it still needs confirming on the owner's phone, `docs/ios-testing.md`.)
- **Server URL:** Settings › Server, else `EXPO_PUBLIC_MARGIN_SERVER_URL`, else production `https://margin-sync.vercel.app` in release builds and `http://127.0.0.1:3000` under development (`__DEV__`). That default matches desktop (packaged → production, unpackaged → local; `defaultServerUrl` in core). https is required; plain http only on loopback, or on private LAN addresses in development builds.

## Risk: another app claiming `margin://`
iOS lets any app declare the same scheme, and which one receives an `openURL` is undefined. What limits it:
1. **ASWebAuthenticationSession** returns the callback to the app that opened the session; the redirect isn't dispatched through `openURL`. A hostile app can't intercept a sign-in **Margin** started.
2. **PKCE:** a code intercepted any other way is useless without the verifier, which never leaves the app that started the flow.
3. **The confirmation page** closes the remaining hole: a hostile app (or a link) that *starts its own* sign-in holds its own verifier, so it could redeem a code delivered to it. That needs the owner's browser to complete GitHub sign-in for a flow they didn't start. GitHub skips its consent screen for an app already authorised, so the server's "Sign in a new device '<name>'?" page is what makes that a visible, deliberate step: it shows the requested device name, and the owner should only press Continue right after tapping Sign In in Margin.
4. **Allowlist and revocation:** only `ALLOWED_GITHUB_LOGINS` can sign in at all, and any device can be revoked in Account and Devices.

Claimed https redirects (universal links, RFC 8252 §7.2) would remove the scheme risk but need an Apple-hosted association file and a built app (M8+).

## Consequences
- `apps/app/test/nativeSync.test.ts` runs the whole flow against the real server app and a mock GitHub: start URL contents, confirmation page Continue/Cancel, wrong `state`, token only in the secret store (no `mgn_` on disk), device list, revoke → signed out on next request, and no token sent to a changed server URL. `apps/server/test/auth.test.ts` covers the redirect allowlist (exact match, binding of the code to the redirect, cancel → `access_denied`).
- **Not verified on a device:** `openAuthSessionAsync` in Expo Go returning the `margin://` callback, the "wants to use … to sign in" prompt, and Keychain persistence across launches.

## Amendments (2026-11-02, validator M6 MAJOR: web-initiated native flow)
- **Finding:** with `margin://auth/callback` accepted in Production, any web page could send Safari to `/api/auth/native/start` with the attacker's own PKCE challenge. If the owner pressed Continue, Safari opened `margin://…?code=…`, and a hostile app claiming the scheme could redeem it (it holds the attacker's verifier). ASWebAuthenticationSession only protects flows *Margin* starts.
- **Fix:** the custom scheme is **development-only**. The server accepts it only with `ALLOW_NATIVE_SCHEME_REDIRECT=1` (for Expo Go / dev builds against a local or preview server), and `loadConfig` **fails closed** if that flag is set in Production (`VERCEL_ENV=production`). Production answers `margin://` with the same 400 as any disallowed redirect, before any cookie or code exists. The desktop loopback redirect is unchanged.
- **Defence in depth when the flag is on:** `native/start` for `margin://` is refused unless `Sec-Fetch-Site` is `none` (the app opened the URL itself) or absent. Links, redirects and form posts from other sites are refused.
- **Confirmation page** now names the client kind ("a Mac app (… 127.0.0.1)" or "an iPhone app (development build, … margin://)") and says plainly: continue only if you chose Sign In yourself; cancel if the page opened from a link, an email or another site. **Residual risk:** for loopback, a page can still start the flow and show the confirmation, but the code can only go to a listener on the owner's own machine at the port the page chose, and it's useless without the attacker's verifier held by whoever runs that listener. That needs local code execution on the owner's Mac, which is outside this model. The wording is the remaining guard against social engineering.
- **Why no native app in production:** the owner chose the free route for iPhone, an installable web app (ADR 0019), so no app that registers `margin://` is distributed. The M6 native app stays as a development/Expo Go target and a future option; distributing it would need a claimed https redirect (universal links) rather than this scheme.
- Tests: `apps/server/test/auth.test.ts` (production config refuses with 400; dev config accepts; cross-/same-site `Sec-Fetch-Site` refused; loopback still works; page names the client), `units.test.ts` (flag parsing; fails closed in Production), `apps/app/test/nativeSync.test.ts` (dev server for the round trip; production-configured server refuses).
