# Best-practices research: distraction-free markdown writer

Researched 2026-11-02. Versions are from the npm registry on that date unless stated otherwise.
**[UNCERTAIN]** marks claims that a spike should confirm before we depend on them.

## TL;DR: recommended stack

| Concern | Pick | Version |
|---|---|---|
| App framework (iOS + web) | `expo` (SDK 58) with `expo-router` | `expo@~58.0.22`, `expo-router@~58.0.29` |
| RN / React / RN-web (pinned by SDK 58) | `react-native`, `react`, `react-dom`, `react-native-web` | `0.88.1`, `19.3.0`, `19.3.0`, `~0.21.4` |
| Desktop shell | `electron` | `45.2.1` (supported majors: 43, 44, 45) |
| Desktop packager | `electron-builder` | `26.18.0` |
| Main/preload bundler | `esbuild` | `0.28.2` |
| Editor (web, desktop and iOS) | CodeMirror 6 inside an Expo DOM component (`'use dom'`) | `codemirror@6.0.2`, `@codemirror/view@6.43.15`, `@codemirror/lang-markdown@6.5.2` |
| Native fallback editor | `@expensify/react-native-live-markdown` | `0.1.367` (needs a dev build, not Expo Go) |
| Font | IBM Plex Mono (OFL), **not** the iA fonts | `@expo-google-fonts/ibm-plex-mono@0.4.1`, `@fontsource/ibm-plex-mono@5.3.0` |
| Font loading | `expo-font` | `~58.0.11` |
| iOS files | `expo-file-system` (new `File`/`Directory` API) | `~58.0.13` |
| iOS token storage | `expo-secure-store` | `~58.0.2` |
| Server storage | Vercel Blob, **private** store | `@vercel/blob@2.8.2` (private needs >= 2.3) |
| Desktop file watching | `chokidar` | `6.0.0` |
| Unit tests | `vitest` | `5.0.5` |
| Electron smoke test | `@playwright/test` (`_electron`) | `1.64.1` |
| Type checking | `typescript` (the version the SDK 58 template pins) | `~6.0.3` |

The architecture hypothesis holds, with one change: **don't split the editor into `Editor.web.tsx` and `Editor.native.tsx`.** Write a single CodeMirror editor as an Expo DOM component. It renders as normal React on web and Electron, and inside a WebView on iOS. Keep `@expensify/react-native-live-markdown` as the fallback if DOM-component typing performance or keyboard handling on iOS turns out to be poor.

---

## 1. Expo SDK version and pnpm monorepo

**Current SDK: 58** (released 2026-10-15; `expo@58.0.22` is `latest`). SDK 58's `bundledNativeModules.json` pins `react-native@0.88.1`, `react@19.3.0`, `react-native-web@~0.21.4`, `react-native-reanimated@4.7.1`, `react-native-worklets@0.13.0`, and `react-native-webview@14.0.1`. The default template pins `typescript@~6.0.3` and `@types/react@~19.3.0`. Always add Expo packages with `npx expo install` so versions match the SDK. Run `npx expo-doctor@latest` in CI.

- **`node-linker=hoisted` is not required.** Expo has supported isolated installs since SDK 54, and pnpm's default (isolated) mode is first-class. If native builds fail on dependency resolution, set `nodeLinker: hoisted` in the root `pnpm-workspace.yaml`, which is where the Expo guide puts it for pnpm 10. Treat hoisting as a fallback, not the default.
- **Metro config: none needed.** Since SDK 52, `expo/metro-config` detects monorepos automatically. Use a plain `getDefaultConfig(__dirname)`, or omit `metro.config.js` entirely. Do **not** set `watchFolders`, `resolver.nodeModulesPaths`, `resolver.extraNodeModules` or `resolver.disableHierarchicalLookup`. The guide tells you to remove them and run `npx expo start --clear` once.
- **Sharing packages:** list `apps/*` and `packages/*` in `pnpm-workspace.yaml`, then depend on `"@writer/core": "workspace:*"`. The `workspace:` protocol stops a same-named package being pulled from the registry. Have the shared packages export TS source directly (`"exports": { ".": "./src/index.ts" }`). Metro, Vitest and esbuild all transpile TS, so no per-package build step is needed. Keep `packages/*` free of React Native imports unless the package is UI.
- Run installs from the repo root only.

Sources: [Expo monorepo guide](https://docs.expo.dev/guides/monorepos/), [Expo changelog](https://expo.dev/changelog), [SDK 57 notes](https://expo.dev/changelog/sdk-57.md), `bundledNativeModules.json` on the `sdk-58` branch of expo/expo.

## 2. Electron wrapping the Expo web export

**Verdict: sound, if you serve the export over a custom protocol rather than `file://`.**

Pitfalls and fixes:

1. **Absolute asset paths break under `file://`.** The export references `/_expo/static/js/...`, and from `file://` that resolves to the filesystem root. Fix: call `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])` before `ready`. Then `protocol.handle('app', ...)` maps `app://bundle/<path>` to `dist/<path>` via `net.fetch(pathToFileURL(...))`, falling back to `index.html` for unknown paths so client-side routing works. Guard against `..` path traversal. A custom scheme also gives you a real origin, so `fetch` to the Vercel API, CORS and `localStorage` behave normally.
2. **Use `web.output: "single"`** (SPA) rather than `"static"`. You don't need SEO or per-route HTML, and a single `index.html` plus the fallback above is the simplest model.
3. **Don't use `experiments.baseUrl`** to fix paths. It is experimental, takes an absolute prefix (`/my-root`), and the docs say nothing about relative or `file://` support. **[UNCERTAIN]** whether `baseUrl: "."` works; not worth finding out.
4. **Dev vs prod:** in dev, `win.loadURL('http://localhost:8081')` (the `expo start --web` server) with `app.isPackaged === false`. In prod, `loadURL('app://bundle/')`. Keep the Expo web export out of the Electron build's own bundling: `electron-builder` copies `apps/mobile/dist` in via `extraResources` or `files`.
5. **IPC / local file access:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (all Electron defaults). A preload script calls `contextBridge.exposeInMainWorld('desktop', { listTree, readFile, writeFile, pickFolder, onFsChange, ... })`. Each function wraps `ipcRenderer.invoke(channel, args)`, and `ipcMain.handle` implements it in main. Sandboxed preloads cannot `require` arbitrary modules, so bundle the preload to a single CJS file with esbuild. In main, resolve every path against the user-chosen root and reject anything outside it. In the app, detect `globalThis.desktop` and pick the matching `StorageAdapter` implementation (Electron fs, iOS `expo-file-system`, browser fallback).
6. **Window niceties for focus mode:** `titleBarStyle: 'hiddenInset'`, `win.setFullScreen(true)` (native macOS Space), and a real application `Menu` so standard shortcuts (Cmd+C/V/Z, Cmd+Ctrl+F) work. Copy/paste breaks without the Edit menu roles.
7. **External links:** use `setWindowOpenHandler` with `shell.openExternal`, and add `will-navigate` guards.

**Alternative considered:** a plain Vite + React DOM app for desktop, with shared core packages and a separate RN UI for iOS. Pros: lighter web tooling, no react-native-web layer, mature Electron templates (`electron-vite@6.0.0`). Cons: two UI codebases (library, folders, settings, focus chrome) and two editor integrations.

**Recommendation:** keep the single Expo app. The decider is the Expo DOM component. The CodeMirror editor, the hardest and largest UI piece, is then *literally the same code* on desktop and iOS, and RN-web covers the comparatively simple library and settings UI. Revisit only if RN-web gets in the way of desktop-grade UI such as context menus, drag-and-drop in the folder tree, or keyboard focus management. That's the most likely friction point. **[UNCERTAIN]**

Sources: [Expo CLI: hosting with sub-paths](https://docs.expo.dev/more/expo-cli/), [Expo static rendering](https://docs.expo.dev/router/reference/static-rendering/), [Electron Forge overview](https://www.electronjs.org/docs/latest/tutorial/forge-overview). The Electron `protocol.handle`, `contextBridge` and security checklist docs on electronjs.org are standard references.

## 3. Electron tooling

- **Electron 45.2.1** (2026-10-30). Supported stable lines are 45, 44 and 43; a new major ships roughly every 8 weeks and only the latest 3 get fixes. Pin a major and plan to bump it quarterly. ([releases.electronjs.org](https://releases.electronjs.org/))
- **Packager: `electron-builder@26.18.0`.** Electron Forge (`@electron-forge/cli@8.0.1`) is the officially maintained option and works fine. electron-builder is the better fit here for three reasons:
  - Our renderer is already built by Expo, so Forge's webpack/Vite plugins add nothing.
  - One declarative config produces a mac `dmg` + `zip`, universal or arm64 builds, hardened runtime and notarisation.
  - `electron-updater` is there if auto-update is wanted later.

  The Electron docs list electron-builder as community-maintained, with no official support from the Electron project.
- **Signing/notarisation:** unsigned local builds run with right-click > Open. Distributing a build needs an Apple Developer ID certificate, and notarisation needs `notarytool`, which comes with the Xcode Command Line Tools rather than full Xcode. **[UNCERTAIN]** whether CLT alone is enough on this machine. Defer this until a public release.
- Bundle `main.ts` and `preload.ts` with `esbuild@0.28.2` (two entry points, `platform: node`, `format: cjs`, `external: ['electron']`).

## 4. Native iOS markdown editor and focus mode

| Option | Raw markdown editing | Per-range styling (dimming) | Expo Go | Shares code with desktop | Verdict |
|---|---|---|---|---|---|
| **CodeMirror 6 in an Expo DOM component** (`'use dom'`, uses `@expo/dom-webview`) | Yes | Full (CM decorations) | Yes | **100%**: same component | **Recommended** |
| WebView + hand-rolled CodeMirror bundle (`react-native-webview@14.0.1`) | Yes | Full | Yes | High, but you write the bridge yourself | Superseded by DOM components |
| `@expensify/react-native-live-markdown@0.1.367` | Yes (drop-in `TextInput`) | Limited: fixed range types (`bold`, `syntax`, `h1`...) and a small `markdownStyle` set. The default parser stops formatting past 4,000 chars; a custom worklet parser is needed. | **No** (dev client; New Arch only; needs `react-native-worklets`, `expensify-common`) | Low | Fallback if WebView typing is poor |
| `react-native-enriched-markdown@1.1.1` (`EnrichedMarkdownTextInput`) | No: WYSIWYG with a format bar, outputs markdown | Unclear | **[UNCERTAIN]** | Low | Wrong model for a plain-text writer |
| Plain `TextInput` (with nested `<Text>` children for styling) | Yes | Possible but costly: re-rendering children on every keystroke hurts cursor and performance on long docs | Yes | None | Prototype only |

**Focus mode with CodeMirror (all platforms):**

- *Dimming:* a `ViewPlugin` computes the active sentence or paragraph from `state.selection.main.head`. Use the markdown syntax tree for paragraphs and `Intl.Segmenter('en', { granularity: 'sentence' })` for sentences. It then applies `Decoration.mark({ class: 'cm-dim' })` to everything outside the active range (two ranges: before and after). `.cm-dim { opacity: .3 }` plus a CSS transition.
- *Typewriter scrolling:* on selection or doc change, dispatch `EditorView.scrollIntoView(head, { y: 'center' })`. Pad `.cm-content` with roughly 50vh at top and bottom so the first and last lines can reach the centre.
- *Hidden chrome:* app state toggles the library, toolbar and status bar. On desktop, also call `win.setFullScreen` via IPC.
- *On live-markdown (fallback):* dimming would mean abusing a range type such as `syntax` with a dimmed colour via a custom parser. **[UNCERTAIN]** whether that's feasible. One more reason to prefer the DOM component.

**DOM-component caveats to spike early [UNCERTAIN]:**

- iOS keyboard avoidance and the input accessory bar.
- Startup cost: the DOM component's plain JS isn't compiled to Hermes bytecode.
- Props cross an async bridge. Pass the document in once and send changes out via a debounced top-level "native action" (`onChange(text)`). Don't round-trip the text through props on every keystroke.
- Use `useDOMImperativeHandle` for commands such as `focus` and `setFocusMode`.

Sources: [Expo DOM components](https://docs.expo.dev/guides/dom-components/), [react-native-live-markdown](https://github.com/Expensify/react-native-live-markdown), [enriched-markdown](https://github.com/software-mansion/enriched-markdown), [enriched markdown docs](https://enriched.swmansion.com/markdown).

## 5. Fonts

**iA Writer Mono/Duo/Quattro license:** SIL OFL 1.1. The license file reads *"Copyright © 2018 Information Architects Inc. with Reserved Font Name 'iA Writer'"* and *"Based on IBM Plex Typeface, Copyright © 2017 IBM Corp. with Reserved Font Name 'Plex'"*.

- **Strictly under the OFL**, bundling the *unmodified* fonts in an open-source app is allowed. The Reserved Font Names only constrain *modified* versions, which can't use "iA Writer" or "Plex" in their names. The OFL FAQ treats subsetting and format conversion as modification, so you could only ship the provided files as-is.
- **But the repo README adds usage guidelines aimed squarely at this project:**
  1. "Do not create text editors that bundle our fonts or use them as their default typefaces. This includes minimalist text editors."
  2. (Guideline 3) "If you want a similar typeface for your editor, use IBM Plex."
  3. "Do not distribute plugins, themes, or other products that imitate iA Writer."

  Whether those guidelines are legally binding on top of the OFL is **[UNCERTAIN]** (not legal advice). Bundling would also put the "iA Writer" name in our font menu, which breaks our no-branding rule.
- **Recommendation: do not bundle the iA fonts.** Ship **IBM Plex Mono** (OFL, upstream of the iA fonts, and iA's own suggestion) as the default writing font, unmodified. IBM Plex Sans and Serif can be optional "proportional" modes. Let users pick any installed system font on desktop if they want iA's.

**Loading:**

- *Expo (iOS + web RN UI):* `@expo-google-fonts/ibm-plex-mono@0.4.1` with `useFonts({ IBMPlexMono_400Regular, ... })` from `expo-font@~58.0.11`. This works in Expo Go and on web, where it injects `@font-face`. For dev or EAS builds, the `expo-font` config plugin can embed fonts natively and avoid the load flash.
- *Inside the CodeMirror DOM component (web, Electron, iOS WebView):* `import '@fontsource/ibm-plex-mono/400.css'` (and `400-italic`, `700`). This uses `@fontsource/ibm-plex-mono@5.3.0` and bundles the `woff2` files, so it works offline in Electron. Set `font-family: 'IBM Plex Mono'` on `.cm-content`.

Sources: [iA-Fonts repo](https://github.com/iaolo/iA-Fonts) (`iA Writer Quattro/LICENSE.md` and README), [IBM Plex](https://github.com/IBM/type).

## 6. Sync design (keep it simple)

**Store:** a **private** Vercel Blob store, created with `vercel blob create-store <name> --access private`. The access mode can't be changed later. Reads require auth and go through our Functions, never a public URL. Since these are personal documents, public is wrong.

- On Vercel, the SDK authenticates via OIDC automatically (`BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN`). No `BLOB_READ_WRITE_TOKEN` is needed in Functions.

**Layout:** one blob per document, with pathname = relative path (`notes/ideas/draft.md`). Folders are just prefixes. `list({ prefix, cursor })` returns `{ pathname, etag, size, uploadedAt }` per blob, paginated at 1,000 and sorted lexicographically. Empty folders need a `.keep` marker blob.

**API (plain Vercel Functions, `api/*.ts`, Web `Request`/`Response`; no Next.js needed):**

- `GET /api/tree` returns the list of `{path, etag, size, uploadedAt}`.
- `GET /api/file?path=` calls `get(path, { access: 'private', useCache: false, ifNoneMatch })` and returns 200 + `ETag` or 304. `useCache: false` matters: overwrites can take up to 60s to propagate through the CDN cache otherwise.
- `PUT /api/file?path=` with an `If-Match: <etag>` header calls `put(path, body, { access: 'private', allowOverwrite: true, ifMatch, contentType: 'text/markdown' })`. For a new file, omit `allowOverwrite` so the call fails if the path exists. Map `BlobPreconditionFailedError` to **409/412**.
- `DELETE /api/file?path=` calls `del(url, { ifMatch })`. `rename()` and `copy()` also accept `ifMatch`.
- Auth: `Authorization: Bearer <SYNC_TOKEN>`, compared with `crypto.timingSafeEqual` in every handler. Don't rely on middleware for this; Vercel's docs warn against it for private blobs. Set `Cache-Control: private, no-store`.

**Conflict handling: optimistic concurrency, keep both copies.** Pure last-write-wins can silently lose prose.

- Each client keeps a sync-state map `{ path: lastSyncedEtag, lastSyncedHash }` outside the documents folder (Electron `userData`, iOS `Paths.document/.sync`).
- **Push:** a local change (hash differs) is sent as PUT with `If-Match: lastSyncedEtag`. On 412, download the remote version and save the local version as `name (conflict <device> <yyyy-mm-dd hh.mm>).md`. Both survive, and the user merges by hand.
- **Pull:** if the remote etag differs from `lastSyncedEtag` and the local copy is unchanged, overwrite the local copy. If both changed, it's a conflict; apply the same keep-both rule.
- **Deletes:** if a path is in the sync state but missing remotely and unchanged locally, delete it locally. If it's missing locally, `del` it remotely with `ifMatch`.
- **When to sync:** on app focus, on save (debounced ~2s), and every ~60s while open. A single user means no realtime channel is needed.

Put this algorithm in `packages/sync` as pure functions over a `StorageAdapter` and an `HttpClient`, so it's fully unit-testable.

**Local storage per platform:**

- *Electron:* real `.md` files in a user-chosen folder (`dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`). Persist the path in `app.getPath('userData')/config.json`. Watch external edits with `chokidar@6.0.0` (or `fs.watch(root, { recursive: true })`, which is supported on macOS). Write atomically: write a temp file, then `rename`.
- *iOS:* `expo-file-system@~58.0.13` with the object API (`new Directory(Paths.document, 'Library')`, `File.text()`, `File.write()`), mirroring the same folder tree. Optionally expose it in the Files app with `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` in `ios.infoPlist`; that needs a dev or EAS build. Store the bearer token in `expo-secure-store@~58.0.2`.
- *Electron token:* encrypt with `safeStorage` (Keychain-backed) before writing it to `userData`.
- *Plain browser (bonus target):* skip local files and use IndexedDB, or keep it online-only.

Sources: [Vercel Blob overview](https://vercel.com/docs/vercel-blob) (private/public, conditional writes, caching), [Private storage](https://vercel.com/docs/vercel-blob/private-storage) (`get`, `useCache`, `ifNoneMatch`), [JS SDK reference](https://vercel.com/docs/vercel-blob/using-blob-sdk) (`list`/`head` fields, `ifMatch` on `put`/`del`/`copy`/`rename`).

## 7. Testing and type checking

- **Vitest `5.0.5`** for `packages/*` (document model, path utilities, the sync algorithm with an in-memory adapter and fake HTTP, and the focus-mode range computation). Use a root `vitest.config.ts` with `test.projects: ['packages/*']`. Server handlers can be tested in Vitest by mocking `@vercel/blob`.
- **CodeMirror extensions** (dimming, typewriter): test in Vitest with `environment: 'jsdom'` by building an `EditorState` and asserting on decorations. No browser needed.
- **Electron smoke test:** `@playwright/test@1.64.1` with `_electron.launch({ args: ['apps/desktop/dist/main.js'] })`, or `executablePath` pointed at the packaged `.app`. Assert that the window opens, the library renders, typing reaches the editor, and a file is written to a temp folder (point the app at it via an env var). Playwright's Electron support is still labelled **experimental** but is the standard choice (Electron v21+). For a packaged build, a single test is enough.
- **RN component tests** are optional. If wanted, use `jest-expo`, because Vitest doesn't run RN cleanly. Keep UI logic thin and push it into packages instead.
- **Type checking:** `typescript@~6.0.3` (what the SDK 58 template pins). TS 7.0.2, the native Go compiler, is `latest` on npm, but stay on 6.x until Expo moves. **[UNCERTAIN]**: try `tsgo` later for speed. Each package gets `"typecheck": "tsc --noEmit"`; the root runs `pnpm -r typecheck`. Share a strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `moduleResolution: "bundler"`). The Expo app extends `expo/tsconfig.base`.
- **CI gate:** `pnpm -r typecheck && pnpm vitest run && npx expo-doctor@latest`, with the Playwright Electron smoke test on macOS runners.
