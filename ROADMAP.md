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

## M3 — Document library & sync
- [ ] Local markdown store with folders (create / rename / move / delete)
- [ ] Library sidebar & quick open
- [ ] Sync server on Vercel (single-user, token auth)
- [ ] Desktop sync client, conflict handling

## M4 — Deployment
- [ ] Vercel production deploy of server
- [ ] macOS app packaging

## M5 — iOS (Expo)
- [ ] iOS app sharing UI + core packages
- [ ] Native editor + focus mode
- [ ] Sync on iOS

## M6 — Polished product
- [ ] Logo / wordmark (original design, SVG source in `assets/brand/`)
- [ ] App icons: macOS `.icns` (electron-builder), iOS icon + splash (Expo `app.json`), favicon for web
- [ ] Consistent visual polish pass: spacing, typography, empty states, onboarding (first-run picks documents folder)
- [ ] README for anyone: what it is, screenshots/GIF, prerequisites, clone → install → run desktop / iOS (Expo Go) / server locally, env vars, deploy-your-own-server guide, troubleshooting
- [ ] LICENSE (MIT) + font licence notice (IBM Plex Mono, OFL)
- [ ] Signed/notarized macOS release build (optional; needs Apple Developer account)

> Earlier milestones keep README's setup section accurate as they land; M6 is the final consolidation and polish.
