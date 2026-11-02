# 0008. Library model: folder tree, operations, watching, first document

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
M3 turns the single fixed document into a library: a folder of plain `.md` files, which also has to be usable by iOS (M6) and sync (M5). The save-pipeline guarantees of ADR 0006 must still hold when documents are created, renamed, moved, deleted or changed on disk while open.

## Decision

### The model is a folder tree of `.md` files, and the logic is pure core code
`@margin/core` `tree.ts` contains:
- `buildTree` turns a flat listing into a nested tree, synthesising any missing ancestor folders.
- `sortNodes` puts folders first, sorted by name, then documents by natural name order or newest first. Folders carry the newest `modifiedAt` of their contents.
- `flattenTree` produces the visible rows, and `ancestorsOf` the folders to expand.
- `validateName` rejects names that are empty, padded with spaces, start with a dot, contain `/ \ :` or NUL, or exceed 200 chars.
- `renamedPath`, `movedPath`, `canMoveInto` (no move into itself or a descendant, no no-op), `rebasePath` (where a path ends up after a rename or move of it or an ancestor), and `uniqueName`, which compares case-insensitively like APFS.
- `newDocumentPath` and `newFolderPath` name new items.
- `fuzzyMatch` and `quickOpen` power quick open.
- `listAll` gives a recursive listing for any `DocumentStore`.

These functions are reused unchanged by the iOS store and by sync.

### Desktop operations (`apps/desktop/src/library.ts`)
- `listTree` returns folders and `.md` files. Dot-entries and symlinks are skipped (symlinks would also be a way out of the root); the listing is capped at depth 64 and 50k entries.
- `createDocument` is exclusive (temp file plus `link`, or the `O_EXCL` fallback). `createFolder` creates the folder.
- `rename` covers both rename and move. It never replaces an existing destination (ADR 0006).
  - For folders, it first waits for every queued write to a path inside the folder.
  - It then moves all tracked state for affected documents (known version, watcher, conflict redirect, read-only flag) to the new paths.
  - It records `old → new`, so a save already in flight to the old path follows the document instead of recreating it. This mapping is cleared when something is created or opened at the old path.
- `delete` goes through `shell.trashItem`, so deletes always go to the Trash. It forgets tracked state for everything under the deleted path.
- All existing rules still apply to every operation: containment (ADR 0002), `.md` files only, no dotfiles, and the per-path write queue.

### Watching
- chokidar 6 watches the whole library (dot-entries ignored, symlinks not followed). Events are debounced to a single `library:changed` notification every 150 ms, and the renderer re-lists.
- The per-document folder watcher from ADR 0006 is unchanged and still drives external-edit and conflict handling for the open document.

### Renderer coordination (`apps/app/src/useWorkspace.ts`)
- **Switching documents** dispatches the editor flush and awaits `SaveScheduler.flush()`. If the save failed, the switch is refused and "Not saved" stays visible. Text is never abandoned to open another document.
- **Renaming or moving the open document, or a folder containing it,** runs inside `SaveScheduler.exclusive()`. That waits for an in-flight save, pauses saving, renames, updates the session path, and then resumes. Text typed meanwhile is saved to the new path.
- **Trashing the open document** flushes first, so the Trash copy has the latest text. The session is then marked closed so nothing can recreate the file, and the most recent remaining document opens (or a new one is created).

### First document and naming
- On launch the app opens:
  1. the **last opened document** (`settings.lastDocument`) if it still exists;
  2. otherwise the **most recently modified** document;
  3. otherwise a **new document named by date**.

  Step 2 differs slightly from the brief. When there is no last-opened document (first run, or a freshly chosen folder) but the folder already has documents, opening the latest one is less surprising than adding an empty file to someone's existing folder.
- **New documents are named by date:** `2026-11-02.md`, then `2026-11-02 2.md`, and so on. We chose this over naming by first line because first-line naming means renaming the open file while the user types. That multiplies rename/save races and filesystem churn (and sync conflicts in M5) for little benefit, since users rename explicitly when they care.

### Library folder
- The default is `~/Documents/Margin`. File › Choose Documents Folder… opens the native folder picker. The app flushes every window first (with the ADR 0006 unsaved-changes dialog if needed), switches the library and its watcher, stores `libraryDir` (and clears `lastDocument`), and reloads the windows.
- `libraryDir` can only be set by the main process; renderer settings patches are stripped of it.
- A remembered folder that no longer exists (e.g. an unplugged drive) falls back to the default instead of being recreated.
- `MARGIN_LIBRARY_DIR` still overrides the folder (used by tests).

## Consequences
- Browser and native stubs use the same `LibraryBackend` over a `DocumentStore`. There, "trash" removes the item, because there is no Trash.
- Multiple windows on one document are still out of scope (ADR 0006).
- Very large libraries (over 50k entries) are truncated in the listing.
