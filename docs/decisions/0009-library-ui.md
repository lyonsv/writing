# 0009. Library UI: sidebar, quick open, shortcuts

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
The library needs UI, but Margin is a distraction-free writer: the default view is just the text. The UI must also run on iOS later (M6) without being rewritten.

## Decision
- **Sidebar** (`components/library/Sidebar.tsx`) is built from React Native primitives (`View`, `Text`, `Pressable`, `TextInput`, `ScrollView`).
  - Hidden by default. Toggled with View › Show Library (⌘\\), stored as `settings.sidebar`.
  - Never shown in focus mode. Asking for the library while in focus mode leaves focus mode.
  - Shows folders (expand/collapse) and documents, highlights the open one, and auto-expands its ancestors.
  - Header buttons: New, Folder, and a sort toggle (A–Z / Recent), also available as View › Sort Library By.
  - Inline rename validates with `validateName` and shows errors in a single quiet line. Escape cancels.
  - **Context actions:** Open, New Document Here, New Folder Here, Rename…, Reveal in Finder, Move to Trash. The desktop shows a **native** context menu through IPC; elsewhere an in-app RN menu is used.
  - **Drag to move** is the only web-specific part (`dnd.web.tsx`: HTML5 drag-and-drop onto folders or the sidebar background for the root, plus right-click). `dnd.tsx` is the native fallback: no drag, long-press opens the actions.
  - The draggable wrapper is a flex column so the whole row is clickable.
- **Quick open** (`components/library/QuickOpen.tsx`, RN primitives): File › Quick Open… (⌘P) opens an overlay ranked by `quickOpen`.
  - ↑/↓ (or Ctrl-P/N) move, Enter opens, Escape or a click outside closes.
  - Focus then returns to the editor (`FOCUS_EDITOR_EVENT`).
  - An empty query lists recent documents.
- **Shortcuts** (desktop menu; the editor binds the same keys outside Electron):

  | Command | Shortcut |
  |---|---|
  | New Document | ⌘N |
  | New Folder | ⇧⌘N |
  | Quick Open… | ⌘P |
  | Show Library | ⌘\\ |
  | Choose Documents Folder… | (menu only) |

  These join ADR 0007's focus shortcuts. None collide with the CodeMirror keymaps we load or with macOS system shortcuts.
- **Commands** from the desktop menu reach the renderer over `margin:command`, restricted to an allow-list (`new-document`, `new-folder`, `quick-open`).

## Consequences
- On iOS, moving an item means renaming it for now; a "Move to…" picker is a candidate for M6.
- The sidebar's top area isn't a window-drag region (the editor's is). That's minor, and could become a web-only drag strip later.

## Amendments (2026-11-02, after M3 validation)
- **Keyboard navigation.** With focus in the sidebar (click a row, or Tab to it): ↑/↓ move, → expands a folder or steps into it, ← collapses a folder or steps out to its parent, Enter/Space open a document or toggle a folder, F2 renames. DOM focus follows the cursor, so Enter/Space are handled by the focused row's `Pressable`; the sidebar handles only arrows and F2, and ignores keys from the rename field and keys with modifiers (menu shortcuts). `onKeyDown` on a `View` is a react-native-web prop, so this is web/desktop-only for now; iOS hardware keyboards are an M6 item.
- **The rename field keeps focus after Enter** (`blurOnSubmit={false}`; `submitBehavior="submit"` on RN). react-native-web otherwise blurs it one macrotask after Enter, and with commit-on-blur that committed text typed after an invalid name.
- **Name limits are in UTF-8 bytes** (`MAX_NAME_BYTES` = 200 in `tree.ts`), not characters, leaving room for `.md`, conflict and counter suffixes under the 255-byte filesystem limit.
- **Truncated listings** (over 50,000 entries or 64 folders deep) show "Showing the first N items" at the bottom of the sidebar.
- **Case-only renames** (`a.md` → `A.md`) work on case-insensitive volumes (via a hidden temp name; ADR 0006's never-replace rule still holds).
