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
