# Trying Margin on your iPhone (Expo Go)

No agent can run iOS here (no Xcode, no simulator; ADR 0005). Everything below is **untested on a device** until you've run it. Expect 20–30 minutes. Note what fails and roughly where.

## Setup (once)
1. On the iPhone, install **Expo Go** from the App Store (it must support SDK 58).
2. On the Mac, from the repo root: `pnpm install`, then `pnpm --filter @margin/app start` (Expo dev server). The Mac and iPhone must be on the same Wi-Fi network. If they can't see each other, use `pnpm --filter @margin/app exec expo start --tunnel`.
3. Scan the QR code with the iPhone camera, which opens it in Expo Go.
4. In development builds the sign-in server defaults to `http://127.0.0.1:3000`, which on a phone is the phone itself. Before signing in, open **Settings → Server → Use production** (`https://margin-sync.vercel.app`). Alternatively, run `pnpm dev:server` on the Mac and enter `http://<Mac's LAN IP>:3000`, or start Expo with `EXPO_PUBLIC_MARGIN_SERVER_URL=…`. LAN sign-in also needs a GitHub OAuth App whose callback is that address.

Your iPhone library is separate from `~/Documents/Margin` until you sign in and sync. Use test documents for the first run.

## 1. Editor and font
- [ ] App opens on a new date-named document, with the keyboard down. Tap the text and type: characters appear without visible lag.
- [ ] **Settings → Diagnostics** shows `font: IBM Plex Mono loaded (inline)`. Also compare by eye: `il1|` should look like Plex Mono, not Menlo/SF Mono.
- [ ] Headings, `**bold**`, `*italic*` and `` `code` `` style; markers (`#`, `*`) are dimmed.
- [ ] Dark mode (Control Centre) switches colours.

## 2. Keyboard
- [ ] Type to the bottom of a long document (paste a few screens of text). The caret line is never hidden behind the keyboard or the toolbar.
- [ ] The toolbar sits directly on the keyboard: **‹ Library · Focus · Sentence · Typewriter · Done**. WebKit's own "‹ › Done" bar is not shown.
- [ ] **Done** hides the keyboard; the text area grows back with no blank band or jump.
- [ ] Rotate to landscape and back with the keyboard up: the caret stays visible.
- [ ] Optional: a Bluetooth/iPad keyboard. ⇧⌘F toggles focus mode, ⌥⌘T typewriter, ⌘P search.

## 3. Focus mode and typewriter
- [ ] **Focus**: everything but the current sentence dims, the status bar disappears, and with the keyboard down there is no chrome at all. Tap the text and the toolbar comes back on the keyboard.
- [ ] The scope button cycles Sentence → Paragraph → No dim.
- [ ] **Typewriter** on: while typing, the caret line stays vertically centred **in the area above the keyboard** (not the whole screen). Hide the keyboard and it re-centres in the full height.
- [ ] Settings → Text Size (iOS Settings › Display & Brightness › Text Size, larger): the editor text and library rows get bigger after returning to Margin.

## 4. Library
- [ ] **‹ Library** shows the document list. **New** creates a dated document and opens it; **Folder** creates a folder with its name ready to edit.
- [ ] Long-press a document: Open, Rename…, Move to…, Delete. Rename it, then move it into a folder with **Move to…**.
- [ ] **Search** finds documents by name and opens them.
- [ ] Delete a document, then **Settings → Recently Deleted → Restore**. It comes back.
- [ ] Type a sentence, then immediately swipe up to the home screen. Force-quit Margin from the app switcher, reopen: the sentence is there (flush on background).

## 5. Sign in and sync
- [ ] **Settings → Account → Sign In with GitHub…**: iOS asks "Margin wants to use margin-sync.vercel.app to sign in", then the page **"Sign in a new device '<your iPhone's name>'?"** appears. Press **Continue**, then GitHub, and you're returned to Margin signed in. (This confirms the `margin://` callback works in Expo Go.)
- [ ] Account shows your login and the devices list, including this iPhone ("this device").
- [ ] Kill and reopen the app: still signed in (Keychain).
- [ ] Write a document on the iPhone; the status line says **Synced** after a few seconds. On the Mac (signed in to the same server) **Sync Now**: the document appears. Edit it on the Mac and sync; on the iPhone **pull down on the library**: the change arrives, and if that document is open in the editor, it reloads.
- [ ] Conflict: turn on Airplane Mode, edit the same document on both devices, turn Airplane Mode off and sync both. Both versions survive (one as `name (conflict …).md`).
- [ ] Delete a document on the Mac and sync both: it disappears on the iPhone and is in Recently Deleted there.
- [ ] Airplane Mode: the status says **Offline**; writing still works and syncs later.
- [ ] Revoke the iPhone from the Mac's Account and Devices: on the next sync the iPhone shows signed out, and its documents stay.
- [ ] Sign Out on the iPhone: its documents stay.

## Reporting
For anything that fails, note the step, what you saw, and (if the editor is involved) Settings → Diagnostics. Expo Go's shake menu → "Open JS debugger" shows console errors.
