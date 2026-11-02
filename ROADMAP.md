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
- [ ] Sentence / paragraph focus dimming
- [ ] Typewriter scrolling
- [ ] Hide all chrome; toggle via shortcut

## M3 — Local document library
- [ ] Local markdown store with folders (create / rename / move / delete)
- [ ] Library sidebar & quick open
- [ ] First-run: choose documents folder (default `~/Documents/Margin`)

## M4 — Authentication (before any server is exposed)
Nothing server-side ships without this. See ADR to be written in this milestone.
- [ ] Sign in with GitHub (OAuth), server-side allowlist so only the owner's GitHub account can sign in
- [ ] Server issues per-device, revocable tokens; desktop stores token in OS keychain (Electron `safeStorage`), iOS in `expo-secure-store`
- [ ] Device list + revoke endpoint; token expiry/refresh
- [ ] Any hosted web build is also behind sign-in
- [ ] Tests: unauthenticated / wrong-user / revoked-token requests are rejected

## M5 — Sync server & desktop sync
- [ ] Sync API on Vercel Functions, auth required on every route (from M4)
- [ ] Vercel Blob **private** store; one file per document, ETag-based writes
- [ ] Desktop sync client; conflicts keep both copies (`name (conflict YYYY-MM-DD).md`)
- [ ] Preview deploys on Vercel; secrets only in Vercel env vars

## M6 — iOS (Expo)
- [ ] iOS app sharing UI + core packages; develop with Expo Go / dev build
- [ ] Shared CodeMirror DOM editor + focus mode on iOS
- [ ] Local store (`expo-file-system`) + sync + sign-in on iOS

## M7 — Polished product
- [ ] Logo / wordmark (original design, SVG source in `assets/brand/`)
- [ ] App icons: macOS `.icns` (electron-builder), iOS icon + splash (Expo `app.json`), favicon for web
- [ ] Consistent visual polish pass: spacing, typography, empty states, onboarding (first-run picks documents folder)
- [ ] README for anyone: what it is, screenshots/GIF, prerequisites, clone → install → run desktop / iOS (Expo Go) / server locally, env vars, deploy-your-own-server guide, troubleshooting
- [ ] LICENSE (MIT) + font licence notice (IBM Plex Mono, OFL)
- [ ] Signed/notarized macOS release build (optional; needs Apple Developer account)

> Earlier milestones keep README's setup section accurate as they land; M7 is the final consolidation and polish.

## M8 — Production deployment (daily use)
Goal: Margin installed and authenticated on the owner's Mac and iPhone, with a real home-screen icon.
- [ ] Server: Vercel production deploy, env vars (OAuth secrets, allowlist, Blob token) set in Vercel only; optional custom domain
- [ ] macOS: packaged `.app` installed in `/Applications`; releases published to GitHub Releases; auto-update via `electron-updater` (requires signing — see below)
- [ ] iOS: **EAS Build → TestFlight** (recommended; needs Apple Developer Program, $99/yr) for a real app with home-screen icon; **EAS Update** for over-the-air JS updates without rebuilding
- [ ] Fallback if no Apple Developer account: install the hosted web build as a home-screen PWA (icon on phone, sign-in required, works via Safari)
- [ ] Not planned: public App Store listing (review overhead isn't needed for personal use; can be added later from the same EAS pipeline)
- [ ] Verify end-to-end: write on Mac → appears on iPhone and vice versa; revoked device loses access
- [ ] Backups: periodic export of the Blob store (e.g. scheduled GitHub Action or Vercel cron to a private archive)
