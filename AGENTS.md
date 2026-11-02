# AGENTS.md

Guidance for AI agents (and humans) continuing development.

## Start here
1. Read `ROADMAP.md` — pick the first unchecked item in the lowest open milestone.
2. Read `docs/decisions/` — don't silently contradict an accepted decision; write a new ADR that supersedes it.
3. Read `docs/research/best-practices.md` for platform conventions. It predates the ADRs; where they disagree, the ADR wins (e.g. §6 sketches a shared `SYNC_TOKEN`; ADRs 0010–0012 replaced that with per-device tokens).
4. Anything needing the owner's accounts (GitHub OAuth App, Vercel project, Apple) is documented for them, not done by agents: see `docs/server-setup.md`.

## Working rules
- Small, focused commits; push after each meaningful step. Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Update `ROADMAP.md` checkboxes in the same commit as the work.
- Record any non-obvious decision as an ADR: `docs/decisions/NNNN-short-title.md` (Context / Decision / Consequences), and add it to `docs/decisions/README.md`. Small corrections or follow-ups to an accepted ADR go in a dated **Amendments** section at its end (as in 0006 and 0009); a change of direction gets a new ADR that supersedes it.
- Cross-platform first: shared logic lives in `packages/*`; platform-specific code uses `.web.tsx` / `.native.tsx` splits rather than runtime branching.
- Never commit secrets. Env vars are documented in `.env.example`; server secrets will live in Vercel env vars only.
- Never weaken the save pipeline guarantees in ADR 0006; `e2e/datasafety.spec.ts` must stay green.
- **Server auth (ADR 0010):** every route goes through the single `requireAuth` middleware in `apps/server/src/createApp.ts`; only the auth routes in `PUBLIC_ROUTES` (native start GET/POST, web start, GitHub callback, code exchange) are public. Add routes to that app, never as separate `api/*.ts` files, and never add to `PUBLIC_ROUTES` without an ADR. ("Don't rely on middleware" in best-practices §6 means Vercel *Routing* Middleware, not this in-function gate.) Never log tokens, codes, `state` or URLs of auth callbacks (so no Hono `logger()`). Every new route needs an entry in `ROUTE_BODY_LIMITS` (a test enforces it). Blob keys under `auth/` belong to auth (ADR 0012).
- **Sync (ADR 0013):** never write library files from sync except through `FileSystemLibrary.*ForSync` (per-path queue + hash guard, no `known` update) and never delete except to the Trash with a hash guard. Any change to `planSync`/`runSync` must keep `packages/core/test/sync.test.ts` green, including the randomised simulation (`SYNC_SEEDS=3000` for a longer run). Server sync keys live under `sync/`; the server rejects blind overwrites (428).
- **Tokens stay in the Electron main process** (ADR 0012). The renderer gets `AccountStatus` / `DeviceInfo` only; authenticated calls go through `AccountManager.request` in main.
- `apps/server` imports only *types* from `@margin/core` (core ships raw TS, which the Vercel build isn't guaranteed to compile). Duplicate a runtime constant if needed, with a test that it matches.
- Deploys: previews only (`npx vercel@latest deploy` from the repo root; the root is linked to `margin-sync`, ADR 0014). Never `--prod`, never change deployment protection, never set or print the GitHub OAuth secrets; the owner does that (`docs/server-setup.md`). After storage changes run `pnpm --filter @margin/server verify:blob` against the real store. `.vercelignore` keeps `.env*` out of uploads.

## Commands
Run everything from the repo root (Node >= 22, pnpm 10).

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspaces. Electron downloads its binary on first launch. |
| `pnpm dev:desktop` | Starts the Expo web dev server on :8081, bundles main/preload, launches Electron against it. |
| `pnpm dev:web` | Expo web dev server only (browser; storage = localStorage). |
| `pnpm dev:server` | Auth server on http://127.0.0.1:3000 (Hono under `@hono/node-server`, in-memory store; no Vercel login). Reads `apps/server/.env.local`; see `docs/server-setup.md`. |
| `pnpm --filter @margin/app start` | Expo dev server for iOS (Expo Go). |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm test` | Vitest: `packages/*`, `apps/desktop` (file library, account/sign-in) and `apps/server` (auth). |
| `pnpm build:desktop` | Expo web export → `apps/app/dist`, esbuild main/preload → `apps/desktop/dist`, electron-builder `--dir` → `apps/desktop/release/mac-arm64/Margin.app` (unsigned). |
| `pnpm test:e2e` | Every Playwright `_electron` suite in `e2e/` (any `*.spec.ts` there runs, so don't leave probe specs behind). Runs the **built** app: after changing `apps/app` run `pnpm build:web`, after `apps/desktop` run `pnpm --filter @margin/desktop build:main` (or `pnpm build:desktop` for both); a stale `dist/` silently tests old code. |
| `pnpm verify:packaged` | Checks the packaged `Margin.app`: Electron fuses are set, it launches, opens the document and quits cleanly. Run after `pnpm build:desktop`. |
| `pnpm --filter @margin/desktop package` | Full dmg + zip (unsigned). |

Keyboard shortcuts (desktop menus; bound in the editor itself elsewhere): New Document ⌘N · New Folder ⇧⌘N · Quick Open ⌘P · Show Library ⌘\ · Focus Mode ⇧⌘F · Focus on Sentence ⌥⌘1 / Paragraph ⌥⌘2 / Nothing ⌥⌘0 · Typewriter Scrolling ⌥⌘T · Full Screen ⌃⌘F. See ADRs 0007 and 0009.

Desktop env overrides (see `.env.example`): `MARGIN_LIBRARY_DIR` (default `~/Documents/Margin`), `MARGIN_USER_DATA_DIR`, `MARGIN_WEB_DIR`, `MARGIN_DEV_SERVER_URL` (dev mode), `MARGIN_SERVER_URL` (sign-in server, default `http://127.0.0.1:3000`), `MARGIN_SHOW_INACTIVE` (don't steal OS focus; used by tests), `MARGIN_TEST_NO_HARDLINKS`, `MARGIN_TEST_LIST_LIMIT` (tests). Server env vars: `.env.example` and `docs/server-setup.md`. **Never point a test or dev run at `~/Documents/Margin`**: e2e uses temp folders via `MARGIN_LIBRARY_DIR` / `MARGIN_USER_DATA_DIR`.

Account menu (app menu): Sign In… · Sign Out · Account and Devices… · Sync Now ⌥⌘S (ADRs 0010–0013). Sidebar keyboard: ↑/↓ · →/← expand/collapse · Enter/Space open · F2 rename (ADR 0009 amendments).

Add Expo packages with `pnpm --filter @margin/app exec expo install <pkg>` so versions match SDK 58. Check with `npx expo-doctor@latest` in `apps/app`.

## Layout
```
apps/app/                 Expo SDK 58 + Expo Router (iOS + web)
  app/                    routes (_layout.tsx, index.tsx = workspace: sidebar + editor + quick open)
  components/library/     Sidebar.tsx, QuickOpen.tsx (RN primitives), dnd.web.tsx / dnd.tsx (drag-and-drop split)
  components/account/     AccountView.tsx: Account & Devices panel (RN primitives, takes an AccountBackend)
  src/account/            account.web.ts (desktop bridge or unavailable), account.native.ts (unavailable until M6)
  components/editor/      MarkdownEditor.tsx ('use dom' CodeMirror 6), focus.ts (dimming, typewriter), theme.ts, fonts.ts
  src/storage/            platform adapters: documentStore.web.ts (Electron IPC or localStorage),
                          documentStore.native.ts (in-memory stubs until M6); documentBackend.ts,
                          libraryBackend.ts, settingsStore.ts
  src/useWorkspace.ts     library listing + open document session (switch/rename/trash vs. saves)
apps/desktop/             Electron 45 shell
  src/main.ts             window, menu, app:// protocol, IPC handlers
  src/preload.ts          contextBridge → window.marginDesktop
  src/account.ts          AccountManager: loopback sign-in (RFC 8252 + PKCE), safeStorage token, authenticated requests
  src/sync.ts             SyncService: runs the core engine against the library + server (timer, nudges, Sync Now, status)
  src/library.ts          FileSystemLibrary: .md files, path-escape checks, write queue, conflicts, watcher
  src/serialQueue.ts      per-path serial task queue
  scripts/                build.mjs (esbuild), dev.mjs
  electron-builder.yml    macOS packaging
apps/server/              Hono app for Vercel Functions (Node, Fluid Compute); auth only so far (M4)
  src/createApp.ts        routes + the one auth gate (requireAuth, PUBLIC_ROUTES)
  src/devices.ts codes.ts nonces.ts  device tokens, one-time codes, OAuth state nonces (ETag-safe, HMAC-keyed)
  src/sync.ts syncPaths.ts  sync manifest CAS + content-addressed objects; server copy of the path rules
  src/store.ts blobStore.ts  KeyValueStore: MemoryStore / private Vercel Blob
  src/config.ts github.ts redirects.ts crypto.ts rateLimit.ts
  server.ts               Vercel entry (default-exports the app; must stay at the package root, ADR 0014); src/dev.ts + local.ts local server
                          Relative imports in apps/server use `.js` extensions: Vercel runs src as native ESM (a test enforces it)
  test/                   Vitest; helpers.ts (mock GitHub via fetch), mockGitHubHttp.ts (real-HTTP mock GitHub,
                          local server, "browser" redirect follower; also used by desktop tests and e2e)
packages/core/            plain TS: document model, paths, DocumentStore, markdown helpers, bridge contract, account types, sync engine,
                          SaveScheduler, conflict-copy naming, focus boundaries, settings, line endings
e2e/                      Playwright Electron suites (smoke, datasafety, focus, library, account)
docs/server-setup.md      owner steps: GitHub OAuth Apps, env vars, Vercel, revoking devices
docs/decisions/           ADRs
```

## Testing
- **Unit (Vitest):** put tests next to the package in `test/*.test.ts`. `packages/core` covers paths, the in-memory store and markdown helpers; `apps/desktop/test` covers `FileSystemLibrary`, including traversal and symlink escapes. New packages are picked up through `vitest.config.ts` `projects`.
- **E2E (Playwright `_electron`):** `e2e/launch.ts` starts `apps/desktop/dist/main.js` with the stock Electron binary and a temp library folder. The packaged app has fuses that block Playwright attaching; `pnpm verify:packaged` covers it instead. `desktop.smoke.spec.ts` covers typing and saving, font, column, marker dimming (incl. `>` and `[ ]`), dark mode, fullscreen and IPC path rejection. `focus.spec.ts` covers focus mode (menu toggles, dimming opacity around the caret, code blocks/headings, persistence, typewriter centring, "Not saved" in focus mode, and no long tasks typing in 20 MB). `library.spec.ts` covers M3 (sidebar toggle, create/rename/sort/trash, drag-to-move, live external changes, quick open, switching with unsaved text, renaming/moving/trashing the open document, relaunch, folder picker); native Trash, Reveal, context menus and the folder picker are stubbed in main by helpers in `e2e/launch.ts`, and `currentDocument(page)` reads the open document. `datasafety.spec.ts` is the regression suite for ADR 0006: quit or close straight after typing, the unsaved-changes dialog (dialogs stubbed in main via `stubDialogs`), hung renderers, CRLF/BOM/non-UTF-8 files, filesystems without hard links (`MARGIN_TEST_NO_HARDLINKS`), a 20 MB document, concurrent writes, external edits (clean and dirty), refused paths, and the failing-save indicator with retry. It needs a macOS GUI session; Electron can't run truly headless on macOS. Run with `MARGIN_SHOW_INACTIVE=1` (the launcher sets it) so the window doesn't steal keystrokes from the user.
- **Server (Vitest, `apps/server/test`):** `auth.test.ts` is the M4 acceptance suite (every rejection case, open redirects, cookie session, rate limits, fail-closed config); `concurrency.test.ts` forces store interleavings (code redemption, touch vs revoke); `units.test.ts` covers config, crypto, Blob mapping. GitHub is mocked; never call real GitHub in tests.
- **Sync:** `packages/core/test/sync.test.ts` (planner table, executor races, randomised two-device simulation with in-memory fakes in `syncFakes.ts`), `apps/server/test/sync.test.ts` (API, CAS, collisions, path-rule agreement with core), `apps/desktop/test/sync.test.ts` (two real libraries + real server: conflicts, offline, delete vs edit, renames, open documents), `e2e/sync.spec.ts` (real Electron). e2e sets `MARGIN_SYNC_INTERVAL_MS` high so syncs happen only when the test asks.
- **Desktop sign-in:** `apps/desktop/test/account.test.ts` runs the full loopback round trip against the real server app and a mock GitHub over HTTP (a test-only import of `apps/server/test`), with a fake `SecretBox`. `e2e/account.spec.ts` does it with the real Electron app and real `safeStorage`; `shell.openExternal` is stubbed in main and the test plays the browser with `browse()`.
- **e2e gotchas:** the newest `.md` in the library opens at launch (ADR 0008), so order fixture writes accordingly. Playwright's Electron traces have no DOM snapshots: for flakes, instrument the page (focus/mutation logs) and run `--repeat-each`. react-native-web blurs a single-line `TextInput` one macrotask after Enter unless `blurOnSubmit={false}`.
- **iOS:** not runnable here (no Xcode). `cd apps/app && npx expo export --platform ios` at least proves the native and DOM bundles compile.
- Before pushing: `pnpm typecheck && pnpm test`, plus `pnpm build:desktop && MARGIN_SHOW_INACTIVE=1 pnpm test:e2e && pnpm verify:packaged` if desktop, app or editor code changed.

## Known limits
- **One huge paragraph (≈2 MB+ on a single line) is slow to edit.** CodeMirror lays out a line as a single unit, so a multi-megabyte line is slow whether or not focus mode is on. Focus mode and typewriter scrolling only touch the visible range and a bounded window around the caret. Large documents made of normal-sized paragraphs (20 MB is tested) stay smooth.
- Sentence detection is English-centric (abbreviation and sentence-opener lists in `packages/core/src/focus.ts`). An ambiguous period before a capitalised word that isn't a common opener (e.g. "etc. Margaret arrived") does not split.
- Saving a 20 MB document copies it once per save (`toString` plus IPC). Saves are debounced adaptively (1 s from 1 MB, 2 s from 5 MB) to keep that rare while typing.
- **~100 ms long tasks in very large documents (≈20 MB) during typing pauses** are CodeMirror's background Lezer parse-ahead, not saves (profiled 2026-11-02). Chromium has `navigator.scheduling.isInputPending`, so `@codemirror/language` parses in 100 ms slices but yields the moment input is pending: measured keystroke-to-paint stayed ≤ 48 ms (median 32 ms) at 20 MB vs ≤ 24 ms at 300 KB, which shows no long tasks. There is no config knob; not fixed.
- Sync limits (ADR 0013): documents over 4 MiB stay local; the manifest caps a library at roughly 20k documents; unreferenced document objects aren't garbage-collected yet (M8); a local and a remote file differing only in case wait (409) until renamed.
- Rate limits on auth endpoints are per server instance (ADR 0010). A device signed out while offline stays valid on the server until revoked elsewhere or expired (ADR 0012).
