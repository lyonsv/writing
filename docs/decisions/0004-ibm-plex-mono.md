# 0004. IBM Plex Mono as the writing font

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
The app is inspired by a well-known minimalist writing app whose duospaced fonts are derived from IBM Plex. Those fonts are SIL OFL 1.1 with the Reserved Font Name "iA Writer". Their repository README also says not to create text editors that bundle them or use them as default typefaces, and to use IBM Plex instead. Margin must not use another product's name or branding.

## Decision
- The default and only bundled writing font is **IBM Plex Mono** (SIL OFL 1.1), shipped unmodified from `@fontsource/ibm-plex-mono@5.3.0`. We bundle the latin subset in weights 400/700, normal and italic.
- We do **not** bundle, reference or name the iA fonts. Users may later pick any installed system font on desktop.
- Settings: 18px, line-height 1.6, ligatures off, measure ~68ch.

## Consequences
- Licence-clean and in line with the upstream authors' explicit request.
- Plex Mono is strictly monospaced, so we lose the "duospace" feel of the derived fonts. A proportional Plex Sans/Serif option can come later.
- Non-latin scripts fall back to system monospace until more subsets are bundled.
