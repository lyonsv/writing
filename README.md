# Margin

A distraction-free markdown writing app for desktop (macOS, Electron) and iOS (Expo), with a shared React codebase and an optional sync server on Vercel.

- **Focus mode**: fullscreen, hidden chrome, current sentence/paragraph highlighted, typewriter scrolling.
- **Library**: plain markdown files, organised in folders, synced across devices.

See [ROADMAP.md](ROADMAP.md) for milestones, [AGENTS.md](AGENTS.md) for how to work on this repo, and [docs/decisions/](docs/decisions/) for architecture decisions.

## Quick start

```sh
pnpm install
pnpm dev:desktop     # Electron + Expo web dev server
pnpm typecheck && pnpm test
pnpm build:desktop && pnpm test:e2e
```

Documents are saved as plain `.md` files in `~/Documents/Margin`.
