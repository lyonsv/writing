# 0021. Storage on a private GitHub repository (replaces Vercel Blob)

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** the Vercel Blob parts of ADR 0012 (storage implementation; its token/HMAC design stands), ADR 0013 (manifest and objects *on Blob*; the sync design stands) and ADR 0014 (Blob stores, `PRODUCTION_BLOB_STORE_ID`, `verify:blob`).

## Context
Both Blob stores on the owner's Hobby account were **suspended** ("This store has been suspended"), most likely after exceeding Hobby's monthly Blob operation limits. Every write failed, which broke sign-in and sync. Steady-state polling (devices every 30 s) would exceed those limits again anyway. The owner chose a **private GitHub repository** (`lyonsv/margin-library`): free, versioned history, and a backup by construction.

## Decision

### `GitHubStore` (`apps/server/src/githubStore.ts`)
It implements the existing `KeyValueStore`, so the manifest, document bodies, devices and single-use marks all live there. Each key is one file on one branch, and **every write is a commit** (message `margin: … [skip ci]`). It uses the REST Contents API with a fine-grained PAT scoped to that one repo, with Contents read/write only.

- **Versions are git blob SHAs, computed locally** (`sha1("blob <len>\0" + bytes)`). One **raw-media** GET (`Accept: application/vnd.github.raw`, which works to 100 MB, past the 1 MB JSON limit) therefore yields both the bytes and the exact `sha` a conditional write needs.
- **Compare-and-swap:**
  - **ifMatch** → `PUT` with `sha`.
  - **create-only** → `PUT` without `sha` (GitHub refuses if the file exists).
  - **Verified against the real API:** GitHub *ignores* a `sha` for a file that doesn't exist and **creates** it. So an ifMatch write first checks the current sha (usually a free 304) and fails with a precondition error if the file is missing or changed. A delete landing between that check and the PUT could still be undone; nothing in Margin deletes a key it also compare-and-swaps (devices are revoked by tombstone; the manifest and the used-set are never deleted).
- **Failures are classified by state, not message.** GitHub answers both a real sha mismatch and a lost race on the branch head (concurrent commits to *different* files) with 409/422. After such a failure the store re-reads the file's sha:
  - If it contradicts the condition (a different sha for ifMatch; present for create), it's `PreconditionFailedError` (→ 412 for sync clients).
  - If the condition still holds, it was a branch-head race: retry with capped exponential backoff and jitter (8 retries by default, then an error, never a fake success).

  Tests force exactly these cases. Removing the classification makes three of them fail.
- **Reads are conditional:** `If-None-Match` with the last HTTP ETag per key (small values only, ≤ 1 MB, at most 256 keys per instance). An unchanged manifest or device record is a **304, which doesn't count against the rate limit**. `Cache-Control: no-cache`; Node's fetch has no HTTP cache.
- **list(prefix)** is one Git Trees API call (`recursive=1`), filtered by prefix. A truncated tree (around 100k files) fails loudly.

### Fewer commits per sign-in: sealed values + one used-set
Every write is a commit, so the short-lived sign-in values no longer get a file each:
- **One-time codes are sealed** (AES-256-GCM, HKDF purpose `one-time-code v1`, separate from the cookie key). They carry identity, challenge, redirect URI, device name and expiry, so **nothing is written when a code is issued**.
- **OAuth `state` and the confirm page's CSRF token** were already carried in sealed cookies; they are no longer pre-registered on the server.
- **Single use** for all three is enforced by **one small record**, `auth/used.json`. It holds the HMAC (AUTH_SECRET) of each used id until its expiry, and is updated by compare-and-swap; expired marks are pruned in the same write. Concurrent use has exactly one winner (tested). Nothing accumulates and there are no delete commits.
- **A sign-in costs 4 commits:** confirm used, state used, code used, device created. Raw values never reach the repo: device tokens and used ids are HMACs keyed by `AUTH_SECRET` (ADR 0012), and document bodies are the user's own text.

### Config and guard
- `MARGIN_STORE=github|memory` (github is assumed when `GITHUB_STORE_TOKEN` is set).
- GitHub needs `GITHUB_STORE_TOKEN`, `GITHUB_STORE_REPO` (`owner/name`) and `GITHUB_STORE_BRANCH`. Missing or malformed config fails closed (generic 500 for every request; `storeFromEnv` never crashes the function). `memory` is refused on Vercel.
- **Production data is off-limits to previews:**

  | Environment | Branch |
  |---|---|
  | Production | `main` |
  | Preview / dev | `preview` |

  On Vercel outside production, `PRODUCTION_GITHUB_STORE=lyonsv/margin-library@main` is required, and the server refuses to run if its own store is that repo and branch (case-insensitive).
- **Blob code is deleted** (`blobStore.ts`, `verify-blob.ts`, the Blob fake; `@vercel/blob` removed). Keeping an unused second backend would be untested surface; git history has it. `MemoryStore` stays for tests and `pnpm dev:server`.

### Tests
- `githubStore.test.ts` covers:
  - the blob-sha vector and byte round trips, including a 4 MiB raw read;
  - create-only, stale ifMatch, and ifMatch on a missing file;
  - forced branch-head races that succeed after retry, versus real mismatches under races that never succeed;
  - giving up when the branch stays busy;
  - N=10 concurrent writers on one key (exactly one wins) and on different keys (all land) under random races;
  - 304s; recursive listing; the token is never sent outside the header.
- The **whole server suite** and the desktop **two-device sync and sign-in suites** also run against `GitHubStore` on a faithful Contents API fake (`test/fakeGitHubContents.ts`, with 5% random branch races), as extra Vitest projects `server-github` and `desktop-github` in `pnpm test`.
- **Real run** (`pnpm --filter @margin/server verify:github`, `preview` branch only, ≤ 90 calls, cleans up), 2026-11-02: 6/6 passed in 47 calls.
  - create-only refused;
  - read-after-write fresh 3/3;
  - an unchanged re-read was a 304;
  - 5 concurrent CAS → 1 winner, 4 precondition failures;
  - ifMatch on a deleted file refused, after the fix above (the first run found it);
  - a 2 MB file round-trips byte-exact.

## Rate budget (GitHub: 5,000 requests/hour per token; secondary limit ~500 content-creating requests/hour)

| Activity, per device | Counted calls | Commits |
|---|---|---|
| Idle, signed in (sync poll every 30 s = 120 polls/h) | ~0 (device record and manifest are 304s) + 1–2 for the hourly device touch | 1/h (touch) |
| Each uploaded document change | ~3 (object PUT, manifest PUT; the precondition read is a 304) | 2 (object + manifest) |
| Each downloaded change on another device | ~2 (manifest 200, object GET) | 0 |
| Sign-in | ~10 | 4 |

- **Worst case:** continuous typing syncs at most every 30 s (the change nudge is debounced, so the timer dominates). That is ≤ 120 uploads/h, ≈ 360 calls and 240 commits per device per hour. Two devices typing non-stop for an hour approach the ~500 commits/hour secondary limit.
- **If that ever bites:** batch the object and the manifest into one commit with the Git Data API (blobs + tree + commit + ref update), or upload less often while typing. Not needed for one writer.
- The hosted web app and iOS use the same API and count the same way.

## Repository growth
- Every write commits a full copy of the changed file. The manifest (~150 B per document) is rewritten on every sync write, and bodies are content-addressed (`sync/objects/<sha256>`), so identical text is stored once.
- GitHub delta-compresses history, so repeated manifest rewrites cost far less than their raw size. Expect roughly tens of MB per year for one active writer.
- Old bodies stay in history (the git history *is* the backup). Unreferenced `sync/objects/*` can be pruned later; history keeps them regardless.
- GitHub recommends repositories stay under 1 GB (5 GB hard warning). A very large or long-lived library may eventually need a squash of old history, done by the owner.

## Consequences
- Requests from the Vercel functions go to `api.github.com`. Writes are slower than Blob was (~300–600 ms per commit), which is acceptable for sync and sign-in.
- The repo is the source of truth and a full, browsable, versioned backup. It must stay **private**; anyone with read access can read the documents (but not mint tokens: stored token values are HMACs).
- The owner manages the PAT's expiry. When it expires, every request fails closed until a new token is set (`docs/server-setup.md`).

## Amendments (2026-11-02, after validation of 7227ae0)
- **Preview guard: canonical branches (validator, MAJOR).** `refs/heads/main`, `heads/main`, `main/` and `main.` got past the old string comparison.
  - Branch names are now canonicalised for both `GITHUB_STORE_BRANCH` and `PRODUCTION_GITHUB_STORE`: a leading `refs/heads/` or `heads/` is stripped, and only `[A-Za-z0-9._-]` is allowed, with no leading or trailing `.` and no `..` (so no slashes; refused otherwise). The store writes to the canonical name.
  - Outside production, **any branch equal to the production branch (case-insensitively) is refused, whatever repo is configured**. Repo names can alias through renames and redirects, so the branch alone decides. Every listed bypass is a unit test.
  - *Option, not needed now:* a separate preview repository with its own PAT would isolate previews completely, even from a misconfigured token.
