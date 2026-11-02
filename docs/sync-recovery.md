# Sync recovery

## "Sync error: the server's copy of N document(s) is older than this Mac's; nothing was changed"

**What it means.** This Mac remembers having synced newer versions than the server now shows (ADR 0013, "stale reads and rollbacks"). Either the server was restored from an older backup (a rollback), or, briefly, it served an out-of-date copy. In both cases sync refuses to act on those documents: it doesn't download the older text, doesn't delete files the server no longer lists, and doesn't upload over it. **Your files on this Mac are untouched.** Other documents keep syncing.

**What to do**
1. **Wait for one or two sync cycles** (or use Margin › Sync Now, ⌥⌘S). A momentary stale read clears itself, and the error goes away.
2. If it persists, the server really went back in time. Find out why: a storage repo reset to an older commit (or a restored backup), someone pointing Margin at a different server or account, or a test deployment using the wrong store (ADR 0014 guards against that last one).
3. Make sure your newest text is safe: it is in the documents folder on this Mac (Margin › Choose Documents Folder… shows which). Optionally copy the folder somewhere first.
4. Use **Margin › Reset Sync State for This Folder…**. Margin forgets what this folder last agreed with the server and compares everything again:
   - **Nothing is deleted** on this Mac or on the server.
   - Documents only on this Mac are uploaded, which restores what the rollback lost on the server.
   - Documents only on the server are downloaded.
   - Where the two differ, **your version is saved as `name (conflict YYYY-MM-DD HHMM).md`**, and the server's version takes the original name. Compare them and keep what you want; the next sync spreads your choice.
5. On your other devices, do the same if they show the error.

**What not to do.** Don't delete the documents folder or Margin's `sync` state files by hand to "start fresh" while a device is signed in. Deleting files there counts as a deletion and syncs as one.

## Other sync messages
- **"N document(s) not synced (too large to sync (over 4 MB))":** documents over 4 MiB stay on this Mac only (ADR 0013).
- **"N item(s) couldn't sync this time; will retry":** usually a file that changed while it was being synced, or a name that collides with another on the server (for example only differing in case). It retries every 30 s. If it never clears, rename one of the two files.
- **"Offline":** the server can't be reached. Everything keeps working locally and syncs when it's back.
