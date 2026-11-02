/**
 * The first-run welcome document (M7). Written into an empty library on the
 * very first launch only (`settings.welcomed`), never again, even after it's
 * deleted. Static text, so two devices that both create it sync as the same
 * file instead of a conflict.
 */
export const WELCOME_PATH = 'Welcome to Margin.md';

export const WELCOME_TEXT = `# Welcome to Margin

Margin is a quiet place to write. Your documents are plain markdown files: they stay yours, open anywhere, and sync between your devices only if you sign in.

You can delete this document whenever you like. It won't come back.

## Write

Just type. Markdown is styled as you write: **bold**, *italic*, \`code\`, # headings, > quotes and - lists. The markers stay visible but quiet.

## Focus

Focus mode hides everything but your text and dims all but the sentence you're in.

- **Focus mode**: ⇧⌘F (on iPhone: Focus, on the bar above the keyboard)
- **Focus on sentence / paragraph / nothing**: ⌥⌘1 / ⌥⌘2 / ⌥⌘0
- **Typewriter scrolling** (keeps the line you're writing in the middle of the screen): ⌥⌘T
- **Full screen**: ⌃⌘F

## Your library

- **New document**: ⌘N · **New folder**: ⇧⌘N
- **Quick open**: ⌘P
- **Show the library**: ⌘\\ (backslash)
- Rename, move and delete from the library (right-click on a Mac, long-press on iPhone). Deleted documents go to the Trash on a Mac and to Recently Deleted on iPhone.

## Sync

Sign in with GitHub (Margin › Sign In… on a Mac, Settings on iPhone) to keep your library in sync. If the same document changes on two devices at once, Margin keeps both versions: yours is saved as "name (conflict …)".

Happy writing.
`;
