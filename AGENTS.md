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
- Never commit secrets. Server config via Vercel env vars; see `.env.example`.

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
| `pnpm test:e2e` | Playwright `_electron` smoke test. Run `pnpm build:desktop` first. |
| `pnpm --filter @margin/desktop package` | Full dmg + zip (unsigned). |

Desktop env overrides: `MARGIN_LIBRARY_DIR` (default `~/Documents/Margin`), `MARGIN_USER_DATA_DIR`, `MARGIN_WEB_DIR`, `MARGIN_DEV_SERVER_URL` (dev mode), `MARGIN_SHOW_INACTIVE` (don't steal OS focus; used by tests).

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
  src/library.ts          FileSystemLibrary: real .md files, path-escape checks
  scripts/                build.mjs (esbuild), dev.mjs
  electron-builder.yml    macOS packaging
packages/core/            plain TS: document model, paths, DocumentStore, markdown helpers, bridge contract
e2e/                      Playwright Electron smoke test
docs/decisions/           ADRs
```

## Testing
- **Unit (Vitest):** put tests next to the package in `test/*.test.ts`. `packages/core` covers paths, the in-memory store and markdown helpers; `apps/desktop/test` covers `FileSystemLibrary`, including traversal and symlink escapes. New packages are picked up through `vitest.config.ts` `projects`.
- **E2E (Playwright `_electron`):** `e2e/desktop.smoke.spec.ts` launches the packaged `Margin.app` if present (else `apps/desktop/dist/main.js`; force with `MARGIN_E2E_UNPACKED=1`), with a temp library folder. It types, asserts the text appears and is saved to `Untitled.md`, checks font, column, marker dimming and dark mode, and confirms IPC rejects paths outside the root. It needs a macOS GUI session; Electron cannot run truly headless on macOS. The window is shown inactive so it won't steal keystrokes from the user.
- **iOS:** not runnable here (no Xcode). `cd apps/app && npx expo export --platform ios` at least proves the native and DOM bundles compile.
- Before pushing: `pnpm typecheck && pnpm test`, plus `pnpm build:desktop && pnpm test:e2e` if desktop or editor code changed.
