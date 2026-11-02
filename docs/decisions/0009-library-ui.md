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
