# 0007. Focus mode: dimming, typewriter scrolling, settings

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
M2 asks for focus mode: dim all but the current sentence or paragraph, typewriter scrolling, cursor-only chrome, and toggles that persist. It must live in the shared CodeMirror DOM component (ADR 0003), so iOS gets it in M6 without a second implementation. It must also stay smooth in 20 MB documents.

## Decision

### Boundary detection is pure core code
`@margin/core` `focus.ts`:
- `sentenceEnds` / `sentenceRangeAt` handle sentences. A boundary is a run of `.!?…`, optionally followed by closing quotes, brackets or emphasis (`" ' ” ’ » ) ] * _`), and then whitespace or the end of the text. Heuristics:
  - **Never ends a sentence:** titles and Latin abbreviations (`Mr.`, `Dr.`, `e.g.`, `i.e.`, `vs.`).
  - **Ends only if the next word is capitalised:** `etc.`, `Inc.`, and dotted forms like `U.S.` or `a.m.`.
  - **Doesn't end before a number:** `No. 5`, `p. 12`, and number-then-number cases.
  - **Not a boundary:** single capital initials (`J. R. R. Tolkien`), and any terminator followed by a lowercase word.
  - **Ellipses** end a sentence only before a capital.

  We use our own rules rather than `Intl.Segmenter`: it isn't available on every target (Hermes), and its English rules miss abbreviations.
- `blockAt` handles markdown blocks: ATX headings, paragraphs (soft-wrapped lines), list items (with continuation lines), blockquotes, fenced code (blank lines inside included; an unclosed fence runs to the end), and thematic breaks. Setext headings are treated as a paragraph plus a thematic break (known limitation).
- `focusRangeAt` combines the two. **Paragraph** scope returns the whole block. **Sentence** scope returns the sentence inside a paragraph, list item or quote, but headings and code blocks stay whole: splitting code into "sentences" is meaningless. A blank line focuses nothing.
- Everything is bounded. Callers supply a `DocAccess` (line prefixes only, at least 256 chars); blocks are scanned at most `maxLines` (500) lines each way; sentences within `maxSentenceScan` (4000) chars of the caret. Fenced-code lookup is injectable. The editor answers it from Lezer's incremental tree, so nothing scans from the top of a 20 MB file.

### Editor (`apps/app/components/editor/focus.ts`)
- **Dimming** is a `ViewPlugin` that recomputes on doc, selection, viewport or tree change. It decorates only `view.visibleRanges`: dimmed text gets `.cm-focus-dim` (opacity 0.28 light / 0.32 dark), and the active unit gets `.cm-focus-active`.
- **Transitions:** the active mark alternates between two identical classes whenever the unit's start moves. The new unit fades in (160 ms), but typing inside it doesn't retrigger the animation. Turning focus on fades the rest out (220 ms).
- **Typewriter scrolling** is a measure-phase plugin. It reads the caret's coordinates and nudges `scrollTop` when the caret is more than 1px off centre. It falls back to a one-off `scrollIntoView({y:'center'})` when the caret isn't rendered after a jump. Pointer selections don't recentre. `.cm-content` gets 50vh top and bottom padding so the first and last lines can be centred. An earlier version dispatched `scrollIntoView` on every transaction; that produced roughly 50 ms long tasks per keystroke in a 20 MB document, and measuring avoids them.
- **Configuration** is held in compartments driven by props (`focusMode`, `focusScope`, `typewriter`), so toggling never remounts the editor.

### Chrome
Focus mode hides the scrollbar and, on desktop, the traffic lights (`setWindowButtonVisibility`), so it is cursor-only both windowed and fullscreen. Informational notices (e.g. "your version was saved as a conflict copy") are suppressed. The **"Not saved"** warning and the read-only (non-UTF-8) warning always show.

### Settings and toggles
- `Settings { focusMode, focusScope: 'sentence'|'paragraph'|'off', typewriter }`, validated by `parseSettings`/`parseSettingsPatch` in core. Typewriter is independent of focus mode. `focusScope: 'off'` means focus mode only hides chrome.
- Persistence is platform-split:
  - **Electron:** the main process owns `userData/settings.json`, written atomically and awaited before quit, and broadcasts changes.
  - **Browser:** localStorage.
  - **Native:** in-memory stub until M6.
- Desktop shortcuts, all in the View menu:

  | Command | Shortcut |
  |---|---|
  | Focus Mode | ⇧⌘F |
  | Focus On › Sentence | ⌥⌘1 |
  | Focus On › Paragraph | ⌥⌘2 |
  | Focus On › Nothing (hide chrome only) | ⌥⌘0 |
  | Typewriter Scrolling | ⌥⌘T |
  | Enter Full Screen | ⌃⌘F |

  None of these collide with the CodeMirror keymaps we load (default + history) or with macOS system shortcuts. Outside Electron (browser, and iOS hardware keyboards later), the editor binds the same keys itself (`Mod-Shift-f`, `Mod-Alt-1/2/0`, `Mod-Alt-t`). Inside Electron it doesn't, so a key press never toggles twice.

## Consequences
- iOS (M6) gets dimming, typewriter scrolling and the same keyboard shortcuts with no extra code. It still needs a settings adapter and a way to toggle on touch devices.
- Opacity-based dimming composes with syntax colours; the trade-off is that the active span is a separate element.
- Known limitations: setext headings; sentence detection is English-centric; very long sentences (over 4000 chars from the caret) are truncated at the scan window.
