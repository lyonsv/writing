# 0015. iOS storage: library in the app's Documents, Recently Deleted instead of a Trash

- **Status:** Accepted
- **Date:** 2026-11-02
- **Related:** ADR 0006 (save pipeline), 0008 (library model), 0013 (sync).

## Context
M6 replaces the in-memory iOS stub with real files. The desktop guarantees (ADR 0006/0008) should hold where iOS allows. There is no Xcode here, so the app runs in Expo Go: only modules Expo Go ships can be used, and nothing can be verified on a device by agents (ADR 0005). iOS has no user-visible Trash that apps can move files to.

## Decision

### Where things live (relative to `Paths.document`, the app's private Documents directory, backed up by iOS)

| Path | What |
|---|---|
| `Margin/` | The library: plain `.md` files and folders, same tree as desktop |
| `.margin/trash/<deletedAt>-<id>/` | Recently Deleted: `item` (the file or folder) + `meta.json` (`originalPath`, `kind`, `deletedAt`) |
| `.margin/settings.json` | Preferences (`Settings` from core), written atomically |
| `.margin/sync/<sha256(server, login, root)[:24]>.json` | Sync base per server and account, as on desktop |
| Keychain (`expo-secure-store`) | The device token only (ADR 0017) |

The trash and app state are **outside** the library folder, so listings, quick open and sync can't see them (sync also refuses hidden paths). The library isn't exposed in the Files app yet (`UIFileSharingEnabled` needs a dev/EAS build, M8).

### Code
- `apps/app/src/native/nativeFs.ts`: the seven filesystem operations the library needs (`stat`, `list`, `readBytes`, `writeAtomic`, `move`, `mkdir`, `remove`). `expoFs.ts` implements them with expo-file-system SDK 58; `apps/app/test/nodeFs.ts` implements them on Node for unit tests (with fault injection).
- `apps/app/src/native/library.ts` (`NativeLibrary`) ports desktop `FileSystemLibrary` semantics on top: core path rules and tree logic, `SerialQueue` (moved to core), `conflictCopyPath`, `uniqueName`, `foldPathCase`.

### Guarantees and how they map to iOS

| Desktop (ADR 0006/0008) | iOS |
|---|---|
| Temp + fsync + rename | **Atomic replace through `writeAsStringAsync` from `expo-file-system/legacy`**, which writes with `Data.write(options: .atomic)`: Foundation writes a temporary file and `rename(2)`s it over the target. The SDK 58 object API can't do this: `File.write` uses `atomically: false`, and `move({ overwrite: true })` deletes the target before moving. This is the one legacy call we use. No explicit fsync (not exposed); iOS flushes on rename as Foundation does. |
| Per-path write queue, coalesced (latest requested text wins) | Same (`SerialQueue` from core). |
| Exclusive create (temp + `link`) | Temp file (atomic write), then a **no-replace move**. |
| Never-replace rename (`link`/`O_EXCL`) | `NativeFs.move` checks the target and moves **synchronously** (`Paths.info` + `moveSync`), so none of our own JS can run in between, and `FileManager.moveItem` refuses an existing target anyway. Nothing else writes into the app's container. Folder moves get the same check (expo's `Directory.move` into an existing folder would nest it). Case-only renames go through a hidden temp name. Source re-checked under the locks. |
| `.md` only, no dotfiles, name ≤ 255 UTF-8 bytes | Same, plus whole path ≤ 1024 bytes (as sync). iOS `PATH_MAX` (1024) applies to the *absolute* path, which adds ~100 bytes of container prefix: a synced path near 1024 bytes could still be refused by the OS. |
| Known version / conflict copy on save | Same: an open document remembers the hash it read or wrote; a save over a file that changed (a sync download) goes to `name (conflict …).md`, and later saves follow it. |
| Watcher → external change | No other writer exists on iOS, so the library emits the change itself after a sync write to an open document (clean editor reloads; dirty editor's next save makes a conflict copy). |
| Delete → macOS Trash | **Delete → Recently Deleted** (below). |
| Flush on quit/close | Flush on `AppState` `background`/`inactive`: the editor hands over pending text through the DOM bridge, the save queue drains, settings are written. |
| Non-UTF-8 opens read-only; BOM and line endings kept | Same (core `decodeUtf8`, which works without `TextDecoder` in Hermes). |

Leftover `.margin-<id>.tmp` files from an interrupted write are removed at start.

### Recently Deleted (instead of a Trash)
- Deleting from the library UI, and sync deleting a file that was deleted on another device (only if it still matches the synced version), both move it to `.margin/trash/`.
- Settings › Recently Deleted lists the items with **Restore** (back to the original path, or `name 2.md` beside a newer file) and **Delete All Permanently** (confirmation).
- Items older than **30 days** are purged at start.
- We chose a folder outside the library over a `.trash/` folder inside it: nothing else (listing, quick open, sync, a future Files-app view) has to remember to skip it.

### Sync hash cache
The iOS library is the only writer, so a hash cached by size + mtime is dropped on every mutation of that path by the library itself (and on any refused or failed sync action), instead of the desktop's ctime/inode key (ADR 0013 amendments), which expo-file-system doesn't expose. Hashes are SHA-256 via `@noble/hashes` (pure JS, synchronous, as `runSync` requires).

## Consequences
- Unit tests (`apps/app/test/library.test.ts`) run the real library logic on real files: path rules, coalescing, failed writes leaving the old text, BOM/non-UTF-8, exclusive create, never-replace file and folder moves, case-only renames, Recently Deleted round trips and purge, sync guards and conflict copies. `nativeSync.test.ts` runs it against the real server; `nativeSimulation.test.ts` runs the randomised two-device simulation with this adapter on one side.
- **Not verified on a device:** the expo-file-system calls themselves (URI encoding of unusual names, `moveSync` semantics, legacy atomic write), and behaviour when iOS kills the app mid-write. See `docs/ios-testing.md`.
- Documents aren't visible in the Files app until a dev/EAS build adds `UIFileSharingEnabled` (M8).
