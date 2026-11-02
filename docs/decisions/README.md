# Architecture Decision Records

One file per decision: `NNNN-title.md` with **Status**, **Context**, **Decision**, **Consequences**. Supersede rather than edit accepted decisions.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-layout.md) | Monorepo layout and package boundaries | Accepted |
| [0002](0002-electron-shell-over-expo-web.md) | Electron shell over the Expo web export (`app://`, sandboxed preload, IPC) | Accepted |
| [0003](0003-codemirror-dom-component.md) | Single CodeMirror 6 editor as an Expo DOM component, with fallback plan | Accepted |
| [0004](0004-ibm-plex-mono.md) | IBM Plex Mono as the writing font | Accepted |
| [0005](0005-no-rust-no-xcode.md) | No Rust or Xcode: Electron on desktop, Expo Go / EAS on iOS | Accepted |
| [0006](0006-save-pipeline.md) | Save pipeline: durability, write queue, external changes and conflicts | Accepted |
| [0007](0007-focus-mode.md) | Focus mode: dimming, typewriter scrolling, settings | Accepted |
| [0008](0008-library-model.md) | Library model: folder tree, operations, watching, first document | Accepted |
| [0009](0009-library-ui.md) | Library UI: sidebar, quick open, shortcuts (amended: keyboard navigation, byte-length names) | Accepted |
| [0010](0010-auth-model.md) | Authentication model: GitHub sign-in, allowlist on login+id, device tokens, one auth gate, Hono | Accepted |
| [0011](0011-native-redirect.md) | Native sign-in: loopback redirect on desktop, `margin://` on iOS | Accepted |
| [0012](0012-token-storage.md) | Token storage: hashed device records in private Vercel Blob; `safeStorage` on desktop (amended: HMAC pepper) | Accepted |
| [0013](0013-sync.md) | Sync: manifest CAS on private Blob, three-way engine in core, guarded desktop client | Accepted |
