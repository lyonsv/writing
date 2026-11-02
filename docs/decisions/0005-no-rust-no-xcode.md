# 0005. No Rust or Xcode: Electron on desktop, Expo Go / EAS on iOS

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
On the development machine (2026-11-02):
- `cargo`/`rustc` are not installed, which rules out Tauri, the lighter alternative to Electron.
- Only the Xcode **Command Line Tools** are installed (`xcodebuild` fails: "requires Xcode"). There is no iOS simulator, `expo run:ios` or local native builds.
- Node 23.7 and pnpm 10.22 are available.

## Decision
- **Desktop:** Electron (ADR 0002), which needs only Node. It is packaged with electron-builder, unsigned for now (`mac.identity: null`). Signing and notarisation wait for M4 and need an Apple Developer ID.
- **iOS:** develop with **Expo Go** on a physical device. DOM components work in Expo Go. Anything that needs native code (e.g. the `react-native-live-markdown` fallback, Files-app integration) uses **EAS Build** in the cloud, not local Xcode.
- CI or local checks for iOS are limited to `expo export --platform ios` (bundling) and `expo-doctor`.

## Consequences
- Larger desktop binary (~250 MB) than Tauri would give.
- iOS runtime behaviour cannot be verified by agents on this machine. M5 needs a human with a device, or EAS.
- Revisit if Rust or Xcode is installed later; a Tauri spike would be a superseding ADR.

## Amendments (2026-11-02, M6)
- M6 was built with Expo Go only. iOS checks here are `expo export --platform ios`, `expo-doctor`, and Node unit/integration tests of the native storage, sync and sign-in logic (behind a `NativeFs` abstraction). Everything on-device is in the owner's checklist, `docs/ios-testing.md`.
