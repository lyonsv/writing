# 0006. Save pipeline: durability, write queue, external changes and conflicts

- **Status:** Accepted
- **Date:** 2026-11-02
- **Context source:** M1 validation found data loss on quit, out-of-order writes, and silent clobbering of external edits.

## Context
A writing app must never lose or silently overwrite prose. The M1 shell saved through a debounced, fire-and-forget IPC call with no quit handling, wrote files without ordering or fsync, and ignored changes made by other programs (another editor, Finder, iCloud, and later our own sync).

## Decision

### Guarantees
1. **Every keystroke reaches disk before a window closes or the app quits.** The only exceptions are a hung or crashed renderer, a `SIGKILL`, or a power loss in the ~300 ms debounce window.
2. **Last requested write wins.** No older content can land after newer content for the same path.
3. **A completed save survives a crash.** Data is written to a temp file, `fsync`ed, renamed over the target, and then the directory is `fsync`ed. (macOS `fsync` does not force the drive cache, `F_FULLFSYNC`; Node doesn't expose it. We accept that.)
4. **We never silently overwrite a change we haven't seen.** If the file on disk differs from what we last read, wrote or acknowledged, our text goes to a conflict copy and the other version is left untouched.
5. **Failures are visible.** A failed save shows a quiet "Not saved — retrying" line and is retried with backoff until it succeeds.

### Renderer (`@margin/core` `SaveScheduler`, `apps/app/src/useDocument.ts`)
- The editor debounces changes by 300 ms. It flushes immediately on editor blur, window blur, `pagehide`, `visibilitychange`→hidden, `beforeunload`, and the `margin:flush` window event.
- `SaveScheduler` keeps at most one save in flight and coalesces newer text (latest wins). On failure it keeps the text and retries after 0.5, 1, 2, 5, 10 and 30 s (the last delay repeats). `flush()` retries immediately and resolves once everything submitted has been attempted.
- The status stays `error` through retries until a save succeeds, and drives the indicator.

### Close / quit handshake (`apps/desktop/src/main.ts`, `preload.ts`)
- `before-quit` and each window's `close` are `preventDefault`ed once. Main sends `margin:flush-request` to the renderer. The renderer dispatches `margin:flush` (the editor synchronously hands over pending text), awaits `SaveScheduler.flush()`, and replies `margin:flush-done`. Main then waits for its write queue to drain before quitting or closing.
- A renderer that doesn't answer within 20 s is abandoned, because it is hung and its text is unreachable anyway.
- `SIGTERM`, `SIGINT` and `SIGHUP` route through `app.quit()`, so they get the same flush.

### Write queue (`apps/desktop/src/library.ts`, `serialQueue.ts`)
- All mutations of a path (save, open, rename, delete, external-change checks, acknowledgements) run through a per-path serial queue. The path key is computed synchronously when the IPC call arrives, so queue order is arrival order.
- Writes are coalesced: when a queued write starts and a newer one for the same path is already queued, it skips and returns `superseded`.
- `rename` takes both path locks in sorted order to avoid deadlock. It never replaces an existing destination: files move with `link()`+`unlink()` (`link` fails atomically with `EEXIST`), and folders by `mkdir(dst)` (exclusive) followed by `rename` onto the empty directory (fails `ENOTEMPTY` if anything appears).
- New documents are created exclusively (temp file + `link()`), so a file that appears concurrently is never truncated.
- Only `.md` files and folders can be created; hidden path segments are refused. Path containment rules are as in ADR 0002.

### External changes and conflicts
- On `open`, main records the document's version (sha256, mtime, size) and watches the **folder** (renames by other editors would orphan a file watcher).
- Before each write to a tracked document, main compares the disk version with the known version. It checks mtime and size first, and hashes only when those differ.
  - **Unchanged:** write, then record the new version.
  - **Changed (content hash differs):** don't touch the file. Write our text to `name (conflict YYYY-MM-DD HHMM).md`, or `… HHMM 2).md` and so on if that name is taken; the name is claimed exclusively. Return `conflict`. Later saves for the original path are redirected to that same copy while the disk version is unchanged, so stragglers don't create more copies. The renderer switches to the copy, opens and watches it, and shows a one-line notice. Naming lives in `@margin/core` (`conflictCopyPath`) for reuse by M5 sync.
  - **Deleted externally:** recreating the file loses nothing, so the save proceeds.
- Watcher events are debounced (75 ms) and the check runs inside the path's queue, so our own writes are never reported. A real change is sent to the renderer as `external-change { content, token }`:
  - **Editor clean** (no pending, in-flight or failed saves, and no unflushed keystrokes): the editor replaces its text, keeping the cursor where possible, and calls `acknowledgeExternal(token)`. Main adopts that version only if disk still matches the token.
  - **Editor dirty:** the editor flushes instead, and the save takes the conflict path above. Both versions survive.

## Consequences
- Data-safety behaviour is covered by `e2e/datasafety.spec.ts` (quit, close, a 20 MB document, concurrent writes, external edits clean and dirty, failing saves) and by unit tests in `packages/core` and `apps/desktop/test`.
- Each save on a large document re-reads the file only when mtime or size changed. A 20 MB document costs one full write per debounced save; acceptable for prose.
- Reloading on an external change replaces the whole document. Undo history includes the reload as one step.
- The protocol is single-window. Multiple windows on the same document would need per-window known versions; that is deferred to M3.
- Browser (localStorage) and the native stub have a single writer and no external-change source, so they only use `SaveScheduler`.
