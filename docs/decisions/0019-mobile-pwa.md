# 0019. Mobile distribution: installable web app (PWA), not TestFlight

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** the "EAS Build → TestFlight (recommended)" item of ROADMAP M8 and the iOS distribution part of ADR 0005.
- **Related:** ADR 0010 (cookie session for the hosted web build), 0014 (Vercel), 0016/0017 (M6 native app).

## Context
Putting the M6 Expo app on the owner's iPhone outside Expo Go needs the Apple Developer Program ($99/year) for TestFlight, or a free provisioning profile that expires every 7 days. The owner chose the free route. iOS Safari can install a web app to the home screen (standalone display, own icon), and Margin already has a web build (it's what Electron runs) plus a cookie session on the server (ADR 0010).

## Decision
- **iPhone (and any browser) uses the hosted web build as an installable PWA,** served from the same Vercel project and origin as the API (`https://margin-sync.vercel.app/`, API under `/api`), so the existing `__Host-` cookie session works without CORS. The HTML shell requires sign-in; static hashed assets may be public (no user data). Details, storage (IndexedDB/OPFS), sync and offline shell are M8 work and get their own ADRs as they're built.
- **No native iOS app is distributed.** The M6 app stays in the repo as a development target (Expo Go, `pnpm --filter @margin/app start`) and a future option if a developer account is ever bought. Because nothing distributed claims `margin://`, the server accepts that redirect only in development (`ALLOW_NATIVE_SCHEME_REDIRECT`, ADR 0017 amendments).
- **macOS stays unsigned:** signing and notarisation are **not planned** (they need the same paid account). Unsigned builds open with right-click → Open the first time (or System Settings › Privacy & Security › Open Anyway). Auto-update via `electron-updater` needs signing on macOS, so updates are manual downloads.

## Consequences
- **Gains:** free, no App Store or TestFlight review or expiry, one web codebase already shared with desktop, updates by deploying.
- **Costs:** Safari's storage can be evicted (mitigated with `navigator.storage.persist()`, sync as the backup, and installing to the home screen, which iOS exempts from the 7-day script-storage cap); no Files-app integration; keyboard handling through `visualViewport` rather than native APIs; web push and background sync are limited.
- Documentation: `docs/ios-testing.md` becomes an "Install on iPhone" guide in M8. The native checklist stays for anyone running the dev app.
