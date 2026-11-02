# Roadmap

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done. Agents: update this file in the same commit as the work.

## M0 — Foundations
- [x] Research platform best practices → `docs/research/best-practices.md`
- [x] Monorepo scaffold (pnpm workspaces, TS, tests) — lint not yet set up
- [x] Architecture decision records in `docs/decisions/`

## M1 — Desktop app running
- [x] Electron shell launching the shared React app
- [x] Editor with writing font, markdown syntax styling
- [x] Fullscreen

## M2 — Focus mode
- [x] Sentence / paragraph focus dimming
- [x] Typewriter scrolling
- [x] Hide all chrome; toggle via shortcut

## M3 — Local document library
- [x] Local markdown store with folders (create / rename / move / delete)
- [x] Library sidebar & quick open
- [x] First-run: choose documents folder (default `~/Documents/Margin`)

## M4 — Authentication (before any server is exposed)
Nothing server-side ships without this. ADRs 0010 (model), 0011 (native redirect), 0012 (token storage); owner steps in `docs/server-setup.md`. Built and tested locally only (no deploy, no real OAuth App yet).
- [x] Sign in with GitHub (OAuth, state + PKCE), server-side allowlist on login **and** immutable id (`ALLOWED_GITHUB_LOGINS=login:id`)
- [x] Server issues per-device, revocable tokens (hashed in private Blob); desktop stores token via Electron `safeStorage`, main process only. iOS (`expo-secure-store`, `margin://` redirect): done in M6
- [x] Device list + revoke endpoints; rolling 90-day expiry refreshed on use; desktop Account & Devices panel, Sign In… / Sign Out menu items
- [x] Any hosted web build is also behind sign-in: server-side cookie session done (`/api/auth/web/start`, HttpOnly/Secure/SameSite=Lax, CSRF Origin check); serving the static build behind it: done in M8 (ADR 0020)
- [x] Tests: no/malformed/forged/revoked/expired token, wrong-user and non-allowlisted GitHub identities, reused code, wrong PKCE verifier, bad state, open redirects; full desktop round trip e2e against a local server + mock GitHub
- [ ] Owner: create the GitHub OAuth Apps and set env vars (`docs/server-setup.md`)

## M5 — Sync server & desktop sync
ADR 0013. Built and tested locally only (no deploy).
- [x] Sync API on Vercel Functions behind the M4 gate: manifest, get, put (If-Match / If-None-Match: *), delete (tombstone), atomic move; 412/428/409/413; same path rules as core (NFC, `.md`, no dotfiles, byte limits); documents over 4 MiB refused
- [x] Vercel Blob **private** store: one manifest updated by ETag compare-and-swap + content-addressed document bodies (deviation from "one object per document path", see ADR 0013)
- [x] Sync engine in `packages/core` (three-way, edit beats delete, renames as moves), randomised two-device tests for convergence and no data loss
- [x] Desktop sync client; conflicts keep both copies (`name (conflict YYYY-MM-DD HHMM).md`); downloads through the save pipeline's queue and conflict logic; base per library folder and account; status line; Sync Now
- [ ] Preview deploys on Vercel; secrets only in Vercel env vars → with the M8 deploy

## M6 — iOS (Expo)
ADRs 0015 (storage, Recently Deleted), 0016 (editor, keyboard, navigation), 0017 (sign-in redirect). Built with Expo Go only; **nothing has run on a device yet**, so the owner's checklist is `docs/ios-testing.md`.
- [x] iOS app sharing UI + core packages: Expo Router stack (library, editor, settings) reusing Sidebar (touch mode, Move to…), QuickOpen (search), AccountView
- [x] Shared CodeMirror DOM editor + focus mode on iOS: keyboard-aware sizing, accessory bar (focus, scope, typewriter, done), typewriter centring above the keyboard, inline IBM Plex Mono, Dynamic Type, status bar hidden in focus mode
- [x] Local store (`expo-file-system`, ADR 0015) with desktop-equivalent guarantees; Recently Deleted (30 days); settings file; flush on background
- [x] Sync on iOS (core engine + shared HTTP client): foreground, after edits, pull-to-refresh, every 60 s while active; Reset Sync State
- [x] Sign-in on iOS: `margin://auth/callback` via ASWebAuthenticationSession + PKCE + confirmation page, token in the Keychain; server URL setting (production default in release builds)
- [x] Re-enable the `margin://auth/callback` redirect on the server, later made development-only (`ALLOW_NATIVE_SCHEME_REDIRECT`; ADR 0017 amendments)
- [x] Tests: native library on real files, sign-in + sync against the real server (iPhone↔iPhone, iPhone↔Mac), randomised native-adapter simulation; `expo export --platform ios` and `expo-doctor` clean
- [ ] (Development only, ADR 0019) Run the native checklist in `docs/ios-testing.md` with Expo Go (keyboard, font, typing latency, sign-in callback, flush on background)

## M7 — Polished product
ADR 0018 (brand). Generated assets: `pnpm brand:build` / `brand:check`, `pnpm notices`, `pnpm docs:screenshots`.
- [x] Logo / wordmark (original design, SVG source in `assets/brand/`: light, dark, mono)
- [x] App icons: macOS `.icns` (electron-builder `mac.icon`, checked by `verify:packaged`), iOS icon light/dark/tinted + splash (`app.json`), favicon + apple-touch-icon for web
- [x] Visual polish: shared UI tokens (spacing, type, radii) for sidebar, quick open, account and the iOS screens; empty library state; signed-out state copy
- [x] First run: a welcome document (shortcuts, focus mode) written into an empty library once, never re-created; folder choice stays in File › Choose Documents Folder… (ADR 0008)
- [x] About: macOS About panel (version, licence, font credit) + Help › Licences; iOS Settings › About
- [x] README for anyone: what it is, screenshots, features and shortcuts, prerequisites, run desktop / iOS (Expo Go) / server, deploy your own server, architecture, troubleshooting (checked from a fresh clone)
- [x] LICENSE (MIT) + THIRD_PARTY_NOTICES.md (IBM Plex Mono OFL in full; generated from production dependencies), bundled in the app
- [ ] ~~Signed/notarized macOS release build~~: **not planned** (ADR 0019; needs a paid Apple account). Unsigned builds open with right-click → Open the first time.

## M8 — Production deployment (daily use)
Goal: Margin on the owner's Mac (packaged app) and iPhone (**installable web app**, ADR 0019), signed in and syncing, at no cost.
- [x] Server: Vercel production deploy (orchestrator), env vars set in Vercel only
- [x] Hosting (ADR 0020): serve the Expo web export from the same project/origin as the API (`https://margin-sync.vercel.app/`, API under `/api`); HTML shell behind sign-in with a minimal sign-in page (web OAuth flow); hashed static assets public; update `vercel.json` and ADR 0014
- [x] Web DocumentStore (ADR 0020, IndexedDB via `NativeLibrary`): IndexedDB or OPFS (research iOS Safari) with native semantics: atomic per-document writes, per-path queue, no-overwrite create/rename, Recently Deleted, conflict copies, core path rules; `navigator.storage.persist()`; migrate localStorage documents; Electron keeps real files (runtime choice)
- [x] Web sync: core engine in the browser over the cookie session; CSRF + Origin checks on every state-changing route; sync on visibility change, timer, after edits, Sync button (no pull-to-refresh in react-native-web); flush on `pagehide` / `visibilitychange`
- [x] PWA: `manifest.webmanifest` (standalone, theme colours, M7 icons), apple-touch-icon, `apple-mobile-web-app-capable` + status-bar style, service worker for an offline app shell that never caches `/api`; safe areas; `visualViewport` keyboard handling (caret visible, typewriter centred in the visible area); reuse the M6 phone screens where react-native-web allows
- [x] Security: `margin://auth/callback` removed from the production allowlist (dev-only flag; ADR 0017 amendments)
- [x] Tests: Playwright WebKit + iPhone profile against a local server: sign-in (mock GitHub), offline edit → reconnect → sync, convergence with desktop, storage semantics, service worker never caches API responses or stale HTML after sign-out; `docs/ios-testing.md` → "Install on iPhone" guide
- [ ] macOS: packaged `.app` in `/Applications`, releases on GitHub Releases (unsigned; manual updates, no `electron-updater` without signing)
- [ ] Confirm on first deploy: GitHub accepts PKCE for the OAuth App; Blob conditional writes behave as ADRs 0012/0013 assume (manifest CAS)
- [ ] Sync maintenance: garbage-collect unreferenced `sync/objects/*` (ADR 0013); backup = export manifest paths → objects
- [ ] Deploy the web app (orchestrator) and confirm the first-deploy items in ADRs 0014/0020
- [ ] Owner: install on iPhone per `docs/ios-testing.md` and verify end-to-end: write on Mac → appears on iPhone and vice versa; revoked device loses access
- [ ] Backups: periodic export of the Blob store (e.g. scheduled GitHub Action or Vercel cron to a private archive)
- Not planned: EAS Build / TestFlight / App Store and signed or notarised macOS builds (ADR 0019). The M6 native app remains a development target (Expo Go).
