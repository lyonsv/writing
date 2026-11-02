# 0018. Brand: the margin-and-caret mark, Plex Mono wordmark, generated icons

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
M7 needs a logo, a wordmark and app icons for macOS, iOS and the web. Margin must not borrow another product's identity: no iA Writer–like marks (their blue caret-on-white "iA" logotype and their fonts are explicitly off-limits, ADR 0004), and no generic stock symbols that look like an existing app.

## Decision
- **Mark:** a page reduced to what Margin is about. There is a thin vertical **margin rule**, three lines of text of which **only the middle one is at full strength** (focus mode dims the rest), and a **caret** at the end of that line, the only colour, in the editor's accent blue `#1a8fc7` (`#4fb3e6` on dark). It is built only from rounded rectangles on a 1024 grid, and it reads at 16 px as "lines of text with a cursor". There are no letters in the mark, so it doesn't depend on a typeface and can't be mistaken for an initial-based logo.
- **Wordmark:** "Margin" in **IBM Plex Mono Medium** (OFL, the app's own writing font, ADR 0004), converted to outlines so the SVGs need no installed font. It's set after the mark, with the mark's focused line level with the x-height.
- **Colours** are the app's own tokens (paper `#fbfbfa`, ink `#1f1f1f`, night `#1b1b1c`, muted rule).
- **Files** (`assets/brand/`): `mark-{light,dark,mono}.svg`, `wordmark-{light,dark,mono}.svg`, `icon-macos.svg`, `icon-ios-{light,dark,tinted}.svg`. *light* is for light backgrounds, *dark* for dark ones, *mono* is single-colour black (use with `fill` overrides or CSS filters).
- **Generated, not hand-exported.** `scripts/brand/build.mjs` holds the geometry and writes every SVG and raster: `pnpm brand:build` regenerates them, and `pnpm brand:check` fails if a committed file differs. It uses resvg (`@resvg/resvg-js`) for rasterising and `opentype.js` for outlining the wordmark; the ICNS container is written directly (PNG entries `icp4`…`ic10`, 16–1024 px), so no `iconutil` or Xcode is needed.
  - **macOS:** a 824×824 rounded square (radius 185) centred on the 1024 canvas, with a soft drop shadow, per Apple's macOS icon grid. Output `apps/desktop/build/icon.icns`, wired as `mac.icon` in `electron-builder.yml`.
  - **iOS:** full-bleed 1024 squares (iOS applies the mask). The *dark* and *tinted* variants have transparent backgrounds as Apple specifies for iOS 18 appearances, wired through SDK 58's `ios.icon: { light, dark, tinted }`. They only take effect in a dev/EAS build; Expo Go shows its own icon.
  - **Splash:** `expo-splash-screen` with the mark on paper (light) or night (dark).
  - **Web:** `web.favicon` (48 px PNG), plus `public/favicon.svg` and `public/apple-touch-icon.png` (180 px, opaque), copied into the web export.

## Consequences
- Changing the logo means editing the geometry in one script and running `pnpm brand:build`; outputs and script are committed together.
- The mark is deliberately quiet. If a louder identity is ever wanted, the caret colour is the one lever.
