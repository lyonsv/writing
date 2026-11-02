# 0012. Token storage: hashed device records in private Vercel Blob; safeStorage on desktop

- **Status:** Accepted (storage on Vercel Blob **superseded by [ADR 0021](0021-github-storage.md)**: a private GitHub repository)
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
    "tokenHash": "<HMAC-SHA256 hex of the secret, keyed by AUTH_SECRET>",
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

## Amendments (2026-11-02, after the M4 security review of 34c08ae)
- **Stored hashes are peppered.** `tokenHash`, the code keys (`auth/codes/<…>.json`) and the OAuth state nonce keys (`auth/states/<…>.json`) are now **HMAC-SHA256** under a key derived from `AUTH_SECRET` (HKDF, label `token-hash v1`, separate from the cookie key), not plain SHA-256. Someone holding only a leaked Blob read-write token could otherwise write `auth/devices/<id>.json` with the SHA-256 of a secret they chose and mint a working device token, or plant a one-time code. Without `AUTH_SECRET` they can't compute a matching MAC. Tests mint such records directly in the store and expect 401/400.
- **Migration:** none needed; nothing was deployed with the unpeppered scheme. Had there been records, they'd simply stop matching (users sign in again).
- **Rotating `AUTH_SECRET`** now signs out **every** device and web session, and cancels sign-ins and codes in flight, because no stored MAC matches under the new key. That is the intended "log everyone out" lever. There is no dual-key grace period; add `AUTH_SECRET_PREVIOUS` (try both keys, rewrite on use) if rotation ever needs to be seamless. Rotate when the secret may have leaked, together with the Blob token if that leaked too.

## Amendments (2026-11-02, verified against the real private Blob store)
`pnpm --filter @margin/server verify:blob` (`apps/server/scripts/verify-blob.ts`) runs the store assumptions against the real `margin-store` under a throwaway prefix, which is deleted afterwards. It found four mismatches with what this ADR assumed; all are fixed and covered by unit tests:
1. **ETags are content-derived:** rewriting identical bytes gives the same ETag. The claim "every successful write produces a new ETag" was false. CAS here stays safe because no CAS user ever writes a key back to an earlier value: device touches and revocations change timestamps, mark-used adds `usedAt`, and the sync manifest bumps `seq`. `MemoryStore` now uses content-derived ETags too.
2. **Create-only on an existing key** fails with a plain `BlobError` ("This blob already exists"), not `BlobPreconditionFailedError`.
3. **ifMatch on a deleted key** fails with a plain `BlobError` ("The specified key does not exist") and creates nothing. Good, and still not relied on.
4. **A losing concurrent conditional write** can fail with a plain `BlobError` ("…conflicting operation…").

`BlobStore` therefore classifies a failed conditional write **by state, not message**: it reads the key's ETag with `head()`, and if that contradicts the condition (present for create; missing or different for ifMatch) it raises `PreconditionFailedError`, which callers retry or report as 412.

5. **`get()` returns weak ETags (`W/"…"`) for compressed responses (larger JSON), but conditional writes only match the strong form.** Every CAS on such a key failed forever. In practice the sync manifest stalled once it grew beyond a few KB. `BlobStore` now normalises ETags to the strong form.

Also confirmed:
- 10 concurrent ifMatch puts → exactly one winner, 9 precondition failures.
- 10 concurrent create-only puts → exactly one winner.
- `useCache: false` reads return the latest write 10/10 times (~150 ms).
- Blob URLs and download URLs return 403 without credentials, and a wrong token fails.
- Deleting a missing key succeeds silently; `del` with a stale ifMatch is refused.
