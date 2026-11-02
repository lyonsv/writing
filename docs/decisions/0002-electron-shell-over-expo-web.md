# 0002. Electron shell over the Expo web export

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
We want one React UI for desktop and iOS. Tauri needs Rust, which isn't installed (see ADR 0005). Expo can export a web build; Electron can host it. Loading an Expo export from `file://` breaks, because it references absolute paths such as `/_expo/static/js/...`.

## Decision
- **Electron 45** (`apps/desktop`) hosts the Expo **web** export (`web.output: "single"`).
- **Prod:** register a privileged `app` scheme (`standard`, `secure`, `supportFetchAPI`) before `ready`, then use `protocol.handle('app', …)` to serve `app://bundle/<path>` from the export via `net.fetch(pathToFileURL(…))`. Unknown paths fall back to `index.html`; paths resolving outside the export folder get a 404. Every response carries a strict `Content-Security-Policy` (scripts `'self'` only; inline styles allowed for react-native-web and CodeMirror). Packaged builds read the export from `Resources/web` (electron-builder `extraResources`).
- **Dev:** `pnpm dev:desktop` starts `expo start --web` and launches Electron with `MARGIN_DEV_SERVER_URL=http://localhost:8081`. The presence of that variable, not `app.isPackaged`, selects dev mode, so the e2e test can run the unpackaged main against the static export.
- **Security:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload is bundled by esbuild into one CJS file (sandboxed preloads can only `require('electron')`) and exposes `window.marginDesktop` through `contextBridge`. Each method is a single `ipcRenderer.invoke`.
- **IPC hardening (main):** handlers check that the sender is the top-level frame on `app://bundle` (or the dev server origin) and that all arguments are strings. Each path goes through `normalizeDocPath` (no absolute paths, `..`, backslashes or NUL), is resolved under the library root, and the real path of its nearest existing ancestor must stay inside the real root, which blocks symlink escapes. Deletes go to the macOS Trash. Writes are atomic: a temp file, then `rename`.
- **Window:** `titleBarStyle: 'hiddenInset'`; the editor renders an invisible 32px `-webkit-app-region: drag` strip. Native fullscreen is a View-menu item with `Control+Command+F`. Standard Edit menu roles are present so copy/paste works.
- **Navigation:** `setWindowOpenHandler` denies new windows (http(s) opens in the browser); `will-navigate` blocks foreign origins.
- Library folder: `~/Documents/Margin` by default. `MARGIN_LIBRARY_DIR` and `MARGIN_USER_DATA_DIR` override it for tests. A folder picker arrives with the library UI (M3).

## Consequences
- The custom scheme gives a real, stable origin, so localStorage, `fetch` and CORS behave normally.
- Gotcha: Node's `URL` reports `origin === "null"` for custom schemes, so origin checks in main compare `protocol//host` instead.
- Bundle size is that of a web app (~1.8 MB JS); acceptable for desktop.
- Revisit if RN-web blocks desktop-grade UI such as context menus or drag-and-drop.
