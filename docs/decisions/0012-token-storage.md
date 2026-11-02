# 0012. Token storage: hashed device records in private Vercel Blob; safeStorage on desktop

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
Device tokens must be revocable, expire, and survive across serverless instances. M5 will store documents in a **private Vercel Blob** store anyway (`docs/research/best-practices.md` §6), and we don't want a second storage provider for a handful of small records. Blob has no transactions, but it does have per-object ETags with conditional `put`/`del` (`ifMatch`).

## Decision

### Server: a minimal key/value interface
`apps/server/src/store.ts` defines `KeyValueStore`: `get` returning value and ETag, `put` with `ifMatch` / `create`, `delete`, and `list(prefix)`.
- `BlobStore` (`blobStore.ts`) implements it on a **private** Blob store.
  - It reads with `access: 'private', useCache: false`; with the CDN cache an overwrite (a revocation) could take up to a minute to show.
  - It writes with `addRandomSuffix: false`, `allowOverwrite: !create`, and `ifMatch`, mapping `BlobPreconditionFailedError` to our `PreconditionFailedError`.
  - On Vercel the SDK authenticates with OIDC (`BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN`, injected when the store is connected); locally it uses `BLOB_READ_WRITE_TOKEN`.
- `MemoryStore` is the same contract in memory, for tests and `pnpm dev:server`. It is refused on Vercel, where each instance would have its own store.
- **Key space:** everything for auth is under `auth/`. **M5 must refuse document paths under `auth/`** (or put documents under their own prefix, e.g. `docs/`).

### Records
- **Devices** are stored at `auth/devices/<id>.json`:
  ```json
  {
    "v": 1,
    "id": "...",
    "tokenHash": "<sha256 hex of the secret>",
    "name": "...",
    "kind": "native|web",
    "githubId": 0,
    "login": "...",
    "createdAt": 0,
    "lastUsedAt": 0,
    "expiresAt": 0,
    "revokedAt": 0
  }
  ```
  `revokedAt` is optional; it is set only on revoked devices.
  - **Token format:** `mgn_<id>.<secret>`. The 22-char id (128-bit) selects the record without an index. The 43-char secret (256-bit) is checked against `tokenHash` in constant time. Tokens are opaque to clients, and the plaintext exists only in the response that issues it and on the device.
  - **Rolling expiry:** a request with a live token pushes `expiresAt` to now + 90 days. To avoid a Blob write per request, this happens at most once an hour (`TOUCH_INTERVAL_MS`). An unused token dies 90 days after its last use. There's no absolute lifetime cap.
  - **Revocation writes a tombstone** (`revokedAt`, `tokenHash` zeroed) with `ifMatch`, retrying on conflict. The touch also uses `ifMatch` on the ETag it read, so a touch racing a revoke fails and re-reads instead of resurrecting the device. We don't delete on revoke, because what Blob does with `ifMatch` on a *deleted* key is undocumented. Tombstones and expired records are pruned a week after death, when devices are listed.
- **One-time codes** are stored at `auth/codes/<sha256(code)>.json` (ADR 0011). Redemption reads the record, then **marks it used with a conditional `put` (`ifMatch` on the ETag it read)** before checking anything else. Of several concurrent redeemers exactly one wins; the rest get a precondition failure. Used and expired codes are swept opportunistically after a minute.
- `test/concurrency.test.ts` forces the exact interleavings (revoke between a touch's read and write, and the reverse; a second redemption between the first's read and write). Removing either `ifMatch` makes those tests fail. They run against `MemoryStore`, so they check our logic, not Blob's conditional-write implementation.

### Desktop: Electron `safeStorage`, main process only
- The token is kept in `AccountManager` (`apps/desktop/src/account.ts`) in the main process. It is written as `userData/account/session.bin`: `safeStorage.encryptString` (Keychain-backed key on macOS), file mode 0600, directory 0700, atomic rename. The file also stores the server origin, so the token is never sent to a different server if the configured URL changes.
- **The renderer never gets the token.** The preload exposes `account.{status, signIn, signOut, listDevices, revokeDevice, onChange}`, which return `AccountStatus` / `DeviceInfo` only, and main makes every authenticated request (`AccountManager.request`, which M5 sync will use). `request` refuses redirects (`redirect: 'error'`) so the bearer header never follows one.
- If `safeStorage` is unavailable, the token is kept in memory for the session and **never written in plain text**.
- A 401 from the server clears the local token (revoked or expired) and reports "signed out".
- Signed out is the default, and startup does no network I/O. The local library never depends on auth.

## Consequences
- Each authenticated request costs one Blob read; touches add a write at most hourly per device. That's cheap at single-user volume.
- Listing devices is `list` + N reads. That's fine for a handful of devices, but would need an index for hundreds.
- Blob is the source of truth for revocation, and `useCache: false` means a revoked token fails on its next request on any instance. There is no in-process token cache to invalidate.
- Signing out offline deletes the local token, but the server record stays valid until it is revoked from another device or expires.
