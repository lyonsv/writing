# 0001. Monorepo layout and package boundaries

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
Margin ships on macOS (desktop) and iOS, and later needs a sync server. We want one codebase, shared logic tested without a UI runtime, and as few build steps as possible.

## Decision
A pnpm 10 workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), default isolated linker (no `nodeLinker: hoisted`).

| Package | What lives there | May depend on |
|---|---|---|
| `packages/core` (`@margin/core`) | Plain TypeScript: document model, library paths (`normalizeDocPath`), `DocumentStore` interface, `MemoryDocumentStore`, markdown helpers, and the desktop IPC bridge contract (`DesktopBridge`, `IPC_CHANNELS`). | Nothing. No React, no React Native, no DOM or Node globals. |
| `apps/app` (`@margin/app`) | Expo SDK 58 + Expo Router app for iOS and web. The UI, the CodeMirror editor DOM component, and platform `DocumentStore` adapters. | `@margin/core`, Expo/RN, CodeMirror |
| `apps/desktop` (`@margin/desktop`) | Electron main + preload, the file-system library, packaging. Loads `apps/app`'s web build. | `@margin/core`, Electron. Never imports from `apps/app`. |

Rules:
- Shared packages export TS source directly (`"exports": { ".": "./src/index.ts" }`); Metro, esbuild and Vitest transpile it. No per-package build step.
- Platform differences use file splits (`*.web.ts` / `*.native.ts`). The one runtime branch is in `documentStore.web.ts`, because the same web bundle runs both in a browser and in Electron; it checks for the preload bridge.
- Strict TS everywhere (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`); the Expo app extends `expo/tsconfig.base` with the same flags. Each package has `typecheck`; the root runs them all.
- Vitest runs from the root over `packages/*` and `apps/desktop` (Node-only code). Electron end-to-end tests use Playwright from the root `e2e/` folder.
- Future packages (`packages/sync`, a server app) follow the same rules.

## Consequences
- `core` is trivially unit-testable and reusable by a future server.
- No Metro config is needed (SDK 52+ detects monorepos).
- Anything both apps must agree on (IPC channel names, bridge types) lives in `core`, so a mismatch is a type error.
