# 0003. A single CodeMirror 6 editor as an Expo DOM component

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
The editor is the largest and hardest UI piece: raw markdown editing, syntax styling, and (M2) per-range dimming plus typewriter scrolling. Native iOS options either can't do arbitrary per-range styling or need a dev client (see `docs/research/best-practices.md` §4).

## Decision
Write one editor, `apps/app/components/editor/MarkdownEditor.tsx`, marked `'use dom'`. On web and Electron Expo renders it as ordinary React DOM. On iOS it runs inside `@expo/dom-webview`.

- CodeMirror 6 with no `basicSetup` (no gutters or line numbers): `history`, `drawSelection`, line wrapping, `@codemirror/lang-markdown`, and a custom theme plus `HighlightStyle`.
- Typography: IBM Plex Mono 18px, line-height 1.6, a centred `max-width: 68ch` column. Markdown markers (`processingInstruction` tags: `#`, `*`, `>`, `-`, backticks, link brackets) take a muted colour, while content keeps the text colour and size.
- Colours are CSS custom properties switched by `prefers-color-scheme`, so light/dark follows the OS without reconfiguring the editor.
- Data flow: the document text goes in once (`initialValue`, remounted via `key` per document). Changes come out through an async `onChange(text)` prop, debounced 300 ms and flushed on blur, `visibilitychange` and `beforeunload`. Text never round-trips through props on every keystroke.
- Fonts: Metro does not rewrite `url()` inside imported CSS, so `@fontsource` CSS imports export without their font files. We `require()` the latin woff2 files as Metro assets (which are exported) and inject our own `@font-face` rules (`components/editor/fonts.ts`).

## Verified
- Electron (static export over `app://`): the Playwright smoke test types, sees text, checks font, size, line-height, dimmed markers and theme switching, and confirms the file is saved.
- `expo export --platform ios` bundles the DOM component (`DOM Bundled … MarkdownEditor.tsx`). It has **not** been run on a device or simulator yet (see ADR 0005).

## Fallback plan
If iOS DOM-component typing latency, keyboard avoidance or the accessory bar prove poor (to be checked in M5 with Expo Go):
1. Keep the CodeMirror component for web/Electron as `MarkdownEditor.web.tsx`, without `'use dom'`.
2. Add `MarkdownEditor.native.tsx` using `@expensify/react-native-live-markdown` (needs a dev build via EAS), with reduced focus-mode styling.
3. The props contract (`initialValue`, `onChange`) stays the same, so screens don't change.

If the font asset approach breaks inside the iOS WebView, the fallback is to inline the woff2 files as data URIs inside the DOM bundle.

## Consequences
- Focus mode (M2) is written once as CodeMirror extensions and tested in Vitest/jsdom.
- On iOS the DOM bundle is plain JS (not Hermes bytecode), so startup cost is to be measured.

## Amendments (2026-11-02, M6)
- **Font in the iOS WebView:** the asset-URL approach does **not** work in exported iOS builds (the DOM page looks for `<hash>.woff2` in `www.bundle/`, but the export puts fonts in `assets/`; the fetch is a 404). The fallback this ADR named is now used on iOS: the native side passes `@font-face` rules with `data:` URIs (ADR 0016). Web/Electron unchanged.
- Keyboard avoidance and the accessory bar are designed in ADR 0016; typing latency on a device is still unmeasured (`docs/ios-testing.md`).
