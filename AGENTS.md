# AGENTS.md

Guidance for AI agents (and humans) continuing development.

## Start here
1. Read `ROADMAP.md` — pick the first unchecked item in the lowest open milestone.
2. Read `docs/decisions/` — don't silently contradict an accepted decision; write a new ADR that supersedes it.
3. Read `docs/research/best-practices.md` for platform conventions.

## Working rules
- Small, focused commits; push after each meaningful step. Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Update `ROADMAP.md` checkboxes in the same commit as the work.
- Record any non-obvious decision as an ADR: `docs/decisions/NNNN-short-title.md` (Context / Decision / Consequences).
- Cross-platform first: shared logic lives in `packages/*`; platform-specific code uses `.web.tsx` / `.native.tsx` splits rather than runtime branching.
- Never commit secrets. Env vars are documented in `.env.example`; server secrets will live in Vercel env vars only.
- Never weaken the save pipeline guarantees in ADR 0006; `e2e/datasafety.spec.ts` must stay green.

## Commands
Run everything from the repo root (Node >= 22, pnpm 10).

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspaces. Electron downloads its binary on first launch. |
| `pnpm dev:desktop` | Starts the Expo web dev server on :8081, bundles main/preload, launches Electron against it. |
| `pnpm dev:web` | Expo web dev server only (browser; storage = localStorage). |
| `pnpm --filter @margin/app start` | Expo dev server for iOS (Expo Go). |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm test` | Vitest: `packages/*` and `apps/desktop` (Node-only file library). |
| `pnpm build:desktop` | Expo web export → `apps/app/dist`, esbuild main/preload → `apps/desktop/dist`, electron-builder `--dir` → `apps/desktop/release/mac-arm64/Margin.app` (unsigned). |
| `pnpm test:e2e` | Playwright `_electron` suites (`e2e/desktop.smoke.spec.ts`, `e2e/datasafety.spec.ts`). Needs `pnpm build:web` and `pnpm --filter @margin/desktop build:main` (or `pnpm build:desktop`). |
| `pnpm verify:packaged` | Checks the packaged `Margin.app`: Electron fuses are set, it launches, opens the document and quits cleanly. Run after `pnpm build:desktop`. |
| `pnpm --filter @margin/desktop package` | Full dmg + zip (unsigned). |

Desktop env overrides (see `.env.example`): `MARGIN_LIBRARY_DIR` (default `~/Documents/Margin`), `MARGIN_USER_DATA_DIR`, `MARGIN_WEB_DIR`, `MARGIN_DEV_SERVER_URL` (dev mode), `MARGIN_SHOW_INACTIVE` (don't steal OS focus; used by tests).

Add Expo packages with `pnpm --filter @margin/app exec expo install <pkg>` so versions match SDK 58. Check with `npx expo-doctor@latest` in `apps/app`.

## Layout
```
apps/app/                 Expo SDK 58 + Expo Router (iOS + web)
  app/                    routes (_layout.tsx, index.tsx = the single-document screen)
  components/editor/      MarkdownEditor.tsx ('use dom' CodeMirror 6), theme.ts, fonts.ts
  src/storage/            DocumentStore adapters: documentStore.web.ts (Electron IPC or localStorage),
                          documentStore.native.ts (in-memory stub until M5)
apps/desktop/             Electron 45 shell
  src/main.ts             window, menu, app:// protocol, IPC handlers
  src/preload.ts          contextBridge → window.marginDesktop
  src/library.ts          FileSystemLibrary: .md files, path-escape checks, write queue, conflicts, watcher
  src/serialQueue.ts      per-path serial task queue
  scripts/                build.mjs (esbuild), dev.mjs
  electron-builder.yml    macOS packaging
packages/core/            plain TS: document model, paths, DocumentStore, markdown helpers, bridge contract,
                          SaveScheduler, conflict-copy naming
e2e/                      Playwright Electron smoke test
docs/decisions/           ADRs
```

## Testing
- **Unit (Vitest):** put tests next to the package in `test/*.test.ts`. `packages/core` covers paths, the in-memory store and markdown helpers; `apps/desktop/test` covers `FileSystemLibrary`, including traversal and symlink escapes. New packages are picked up through `vitest.config.ts` `projects`.
- **E2E (Playwright `_electron`):** `e2e/launch.ts` starts `apps/desktop/dist/main.js` with the stock Electron binary and a temp library folder. The packaged app has fuses that block Playwright attaching; `pnpm verify:packaged` covers it instead. `desktop.smoke.spec.ts` covers typing and saving, font, column, marker dimming (incl. `>` and `[ ]`), dark mode, fullscreen and IPC path rejection. `datasafety.spec.ts` is the regression suite for ADR 0006: quit or close straight after typing, a 20 MB document, concurrent writes, external edits (clean and dirty), refused paths, and the failing-save indicator with retry. It needs a macOS GUI session; Electron can't run truly headless on macOS. Run with `MARGIN_SHOW_INACTIVE=1` (the launcher sets it) so the window doesn't steal keystrokes from the user.
- **iOS:** not runnable here (no Xcode). `cd apps/app && npx expo export --platform ios` at least proves the native and DOM bundles compile.
- Before pushing: `pnpm typecheck && pnpm test`, plus `pnpm build:desktop && pnpm test:e2e && pnpm verify:packaged` if desktop or editor code changed.
