# 0011. Native sign-in: loopback redirect on desktop, custom scheme on iOS

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
Native apps sign in through the system browser (RFC 8252: never an embedded web view, which could read the user's GitHub password). The server needs a way to hand the result back to the app. RFC 8252 offers three redirect types: a private-use URI scheme (`margin://…`, §7.1), a claimed https URL (§7.2, needs Apple app-site association), or a loopback interface (`http://127.0.0.1:<port>/…`, §7.3).

The server is a confidential client of GitHub and a public authorization server for our apps. It never gives the app GitHub's code or token. It gives the app **its own** one-time code, bound to a PKCE challenge the app sent at the start.

## Decision

### Flow (both platforms)
1. The app makes a PKCE `code_verifier` (256-bit), its S256 `code_challenge` and a random `state`. It opens the system browser at
   `GET {server}/api/auth/native/start?redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…`.
2. The server validates `redirect_uri` against the allowlist below, stores the request in the sealed state cookie (ADR 0010) and runs the GitHub sign-in.
3. On success it redirects to `redirect_uri?code=<one-time>&state=<app's state>`. The code is 256-bit, lives 60 s, is stored only as SHA-256, and is bound to `redirect_uri` and `code_challenge`. On failure it redirects there with `error=access_denied|server_error` (the app stops waiting). If `state` or the cookie is bad, it shows a 400 page and does not redirect.
4. The app checks `state` and POSTs `{ code, code_verifier, redirect_uri, device_name }` to `/api/auth/native/token`. The code is **single-use even under concurrent redemption** (ADR 0012), and any attempt burns it, including one with a wrong verifier. A wrong verifier, wrong redirect, an expired or reused code, or a now-disallowed user all get `400 invalid_grant`.

### Allowed redirect URIs (exact regexes, no URL normalisation)
- `http://127.0.0.1:<1024–65535>/callback` and `http://[::1]:<port>/callback`: the desktop loopback. `localhost` is refused (RFC 8252 §8.3: it may not resolve to loopback). So are anything with a query, fragment, credentials, other path, or https.
- `margin://auth/callback` exactly: iOS (M6).

### Desktop: loopback, not a custom scheme
`apps/desktop/src/account.ts` listens on `127.0.0.1:0` (an OS-chosen port) only for the duration of one sign-in. It answers only `GET /callback` with the exact `state`, and ignores and answers anything else, so a local process can't cut the sign-in short. It then closes.

We chose loopback over `margin://` for Electron because:
- **No OS registration.** A custom scheme needs `app.setAsDefaultProtocolClient` and an Info.plist `CFBundleURLTypes` entry, and only works reliably for the packaged, installed app. In development the scheme points at the generic Electron binary, and a second copy of the app (dev vs `/Applications`) steals it.
- **No hijacking.** Any app can register `margin://`. Only we can be listening on the port we were just given. PKCE already protects a hijacked code, but loopback removes the interception in the first place.
- **Testable end to end.** The e2e test follows the real redirect into the app's listener (`e2e/account.spec.ts`). A scheme would need the OS to dispatch an `open-url` event, which we could only fake.
- The cost is a small HTTP listener and a "you can close this tab" page.

### iOS (M6): custom scheme
`expo-auth-session` with `margin://auth/callback` (`scheme: "margin"` in `app.json`) and PKCE. iOS apps can't keep a loopback listener running while Safari is in front, and `ASWebAuthenticationSession` returns the callback URL to the app that started it, which mitigates scheme hijacking. The token goes to `expo-secure-store`.

## Consequences
- The server accepts any loopback port. That is fine: the code is useless without the verifier, which never leaves the app.
- One sign-in at a time per app. Clicking Sign In again cancels the pending one, and an abandoned attempt times out after 5 minutes.
- The browser keeps one pending sign-in cookie. Starting two sign-ins in the same browser at once makes the first one fail its state check, which is harmless.
