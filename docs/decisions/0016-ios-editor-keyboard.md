# 0016. iOS editor: keyboard, accessory bar, font, navigation

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR 0003 (CodeMirror DOM component), 0004 (font), 0007 (focus mode), 0009 (library UI).

## Context
The shared CodeMirror editor runs on iOS inside `@expo/dom-webview` (a WKWebView). ADR 0003 left four things unproven on iOS: keyboard avoidance, the accessory bar, IBM Plex Mono inside the WebView, and typing latency. A phone also needs touch toggles for focus mode (there's no menu bar) and a phone-shaped library.

## Decision

### Navigation (Expo Router stack, iOS-only routes)
- `app/_layout.native.tsx`: a stack sharing one workspace (`src/WorkspaceContext.tsx`: settings, library listing, the open document and its save pipeline, i.e. the same `useWorkspace` as desktop).
- `index.native.tsx` **Library**: the desktop `Sidebar` in `touch` mode (full width, finger-sized rows, Dynamic-Type-scaled text), long-press for actions (Open, New Document/Folder Here, Rename…, **Move to…** with a folder picker, Delete), pull to refresh (syncs), **Search** = the desktop `QuickOpen`. On launch the last document opens straight away (back goes to the library).
- `editor.native.tsx` **Editor**; `settings.native.tsx` **Settings** (modal): focus options, account and devices (`AccountView`, `inline`), sync status / Sync Now / Reset Sync State, server URL, Recently Deleted, diagnostics.
- `editor.tsx` / `settings.tsx` are web fallbacks that redirect to `/` (Expo Router requires a non-platform sibling). Web and desktop are unchanged: still the single workspace at `/`.

### Keyboard
- The screen tracks the keyboard frame (`keyboardWillChangeFrame` / `keyboardWillHide`) and pads its bottom by the overlap, animated with the keyboard's own curve. The WebView therefore **shrinks** to the visible area instead of being covered.
- In the WebView (`dom` props): `scrollEnabled: false`, `bounces: false`, `contentInsetAdjustmentBehavior: 'never'`, `automaticallyAdjustContentInsets: false`, and the page itself never scrolls (`html, body { overflow: hidden }`, only inside the native WebView). CodeMirror's own scroller does all scrolling.
- On `resize` the editor undoes any page scroll WebKit made and scrolls the caret into view (48px margin). With typewriter scrolling, the plugin now also re-centres on **geometry changes** while focused, so the caret line is centred in the area above the keyboard. `50vh` padding tracks the WebView's height.
- WebKit's own "‹ › Done" bar is hidden (`hideKeyboardAccessoryView`). Margin's bar sits on top of the keyboard: **‹ Library · Focus · Sentence/Paragraph/No dim (cycles) · Typewriter · Done** (hide keyboard). It also shows when the keyboard is down, except in focus mode, where nothing but text is on screen. Tapping the text brings the keyboard and the bar back.
- Hardware keyboards use the editor's own shortcuts (ADR 0007): ⇧⌘F, ⌥⌘1/2/0, ⌥⌘T, ⌘N, ⌘P (search) and ⌘\ (library).

### Chrome, safe areas, Dynamic Type
- The status bar is hidden in focus mode (`expo-status-bar` `hidden`); top and bottom safe-area insets are always respected (notch, Dynamic Island, home indicator).
- Editor text size is 18px × the iOS text-size setting (`useWindowDimensions().fontScale`, clamped 0.8–1.6) through a `--margin-font-scale` CSS variable (desktop: 1). RN text (library, settings, toolbar) scales natively; the toolbar caps at 1.4× to stay one line.

### Font inside the WebView
The DOM bundle references its woff2 files by a bare relative URL. **`expo export --platform ios` puts those files in `assets/`, not next to the DOM page in `www.bundle/`; fetching the URL from the exported page returns 404** (checked by serving the export and loading the page in WebKit 27.2), so an exported or embedded build would quietly fall back to a system monospace font. Fix: the native side resolves the same font assets with `expo-asset` (dev server in Expo Go, app bundle in builds), reads them with expo-file-system, and passes the editor `@font-face` rules with `data:` URIs (`fontCss` prop, ~84 KB once per mount). Loading those exact rules in WebKit 27.2 reports the face loaded (`document.fonts.check` true). Web and Electron keep the URL approach (CSP and bundle unchanged). The editor reports `document.fonts.check(...)` back, shown in Settings › Diagnostics, so the owner can confirm on a phone.

### Flushing across the bridge
On iOS the editor isn't in the RN document, so `window.dispatchEvent(FLUSH_EVENT)` can't reach it. `src/editorFlush.ts` holds a flusher: the editor screen sends `flushRequest` (a counter) to the DOM component, which flushes (`onChange`) and then answers `onFlushed(id)`. Messages arrive in order, so the text is in the save scheduler before the answer. The workspace uses this when switching documents, before sync, when leaving the editor, and on `AppState` background/inactive. A 1.5 s timeout covers an editor that isn't mounted.

## Consequences
- **Not verified on a device:** keyboard geometry (frames, rotation, iPad split keyboard, hardware keyboard), WebKit scroll behaviour, Dynamic Type scaling, typing latency in large documents inside the WebView, and the `expo-asset` font path in Expo Go. The owner's checklist is `docs/ios-testing.md`.
- The ADR 0003 fallback (`react-native-live-markdown` in a dev build) remains the plan if typing in the WebView proves poor.
