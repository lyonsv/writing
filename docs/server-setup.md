# Server setup (owner steps)

These steps need the repository owner's GitHub and Vercel accounts, so agents don't do them. M4 built and tested the server locally against a mock GitHub. Running it for real needs a GitHub OAuth App and the environment variables below. Design: ADRs 0010–0012.

## 1. Find your GitHub user id
The allowlist pins your immutable numeric id as well as your login, so a renamed or recycled username can't sign in.

```sh
curl -s https://api.github.com/users/lyonsv | grep '"id"'
#   "id": 1234567,
```

## 2. Create GitHub OAuth Apps (one for local dev, one for production)
GitHub › Settings › Developer settings › **OAuth Apps** › **New OAuth App**. An OAuth App has a single callback URL, so use one app per environment.

| Field | Local dev app ("Margin (dev)") | Production app ("Margin") |
|---|---|---|
| Homepage URL | `http://127.0.0.1:3000` | `https://<your-domain>` |
| Authorization callback URL | `http://127.0.0.1:3000/api/auth/github/callback` | `https://<your-domain>/api/auth/github/callback` |
| Enable Device Flow | off | off |

Then **Generate a new client secret**, and copy the Client ID and secret.

- Use `127.0.0.1`, not `localhost`, everywhere locally (`PUBLIC_URL`, the callback, the desktop server URL). The dev server binds 127.0.0.1, and the sign-in cookie is per host.
- The callback host and port must equal `PUBLIC_URL` exactly.
- No scopes are requested. Margin only reads your public id and login, then discards GitHub's token.

## 3. Environment variables
Every variable is listed in `.env.example`.

| Variable | Required | Example / notes |
|---|---|---|
| `PUBLIC_URL` | yes | `http://127.0.0.1:3000` locally; `https://<your-domain>` in production. Origin only. |
| `GITHUB_CLIENT_ID` | yes | From the OAuth App for this environment. |
| `GITHUB_CLIENT_SECRET` | yes | Secret. Vercel env vars or `apps/server/.env.local` only. |
| `ALLOWED_GITHUB_LOGINS` | yes | `lyonsv:1234567`, a comma-separated list of `login:id` pairs. Both must match. |
| `AUTH_SECRET` | yes | ≥ 32 random characters: `openssl rand -base64 48`. Seals the sign-in cookies and keys the stored token/code hashes (HMAC). **Rotating it signs out every device and web session** (ADR 0012). |
| `BLOB_STORE_ID` | prod | Injected by Vercel when a Blob store is connected (with `VERCEL_OIDC_TOKEN`). |
| `BLOB_READ_WRITE_TOKEN` | optional | Only to use a real Blob store from a local machine. |
| `MARGIN_STORE` | local | `memory` for local dev (refused on Vercel). |
| `PORT` | local | Dev server port (default 3000). |
| `GITHUB_OAUTH_URL`, `GITHUB_API_URL` | tests only | Point at a mock GitHub. Leave unset. |

The server refuses to run half-configured: a missing or invalid variable makes every request return a generic 500, with the reason in the logs (`config.error`).

## 4. Run locally
```sh
cat > apps/server/.env.local <<'EOF'   # git-ignored
PUBLIC_URL=http://127.0.0.1:3000
GITHUB_CLIENT_ID=<dev app client id>
GITHUB_CLIENT_SECRET=<dev app secret>
ALLOWED_GITHUB_LOGINS=lyonsv:<your id>
AUTH_SECRET=<openssl rand -base64 48>
MARGIN_STORE=memory
EOF
pnpm dev:server            # http://127.0.0.1:3000, in-memory store (forgets devices on restart)
pnpm dev:desktop           # in another terminal; Margin › Sign In…
```
In development (`pnpm dev:desktop`, unpackaged) the desktop app talks to `http://127.0.0.1:3000`; the packaged app defaults to production `https://margin-sync.vercel.app`, and iOS release builds do too (Expo Go uses `127.0.0.1:3000` unless you pick a server in Settings › Server; see `docs/ios-testing.md`). To point it elsewhere, set `MARGIN_SERVER_URL`, or add `"serverUrl": "https://<your-domain>"` to `settings.json` in the app's userData folder (`~/Library/Application Support/Margin/` when packaged).

## 5. Vercel: what's provisioned, and what's left for you
Config and reasoning: ADR 0014. Everything below was set up on 2026-11-02 with the logged-in CLI (`npx vercel@latest`, run from the repo root, which is linked to the project).

**Already done**

| What | Value |
|---|---|
| Project | `margin-sync` (scope `vincent-lyons-projects-fe5e48fc`): Root Directory `apps/server`, framework Hono, Node 24.x, Fluid Compute, region iad1 |
| Production alias | `https://margin-sync.vercel.app` |
| Blob stores | `margin-store` (`store_wIWFdLVUkOUhtb05`, **private**, iad1): **Production only**. `margin-store-preview` (`store_RCqGVGmwoZxS2m4D`, private): **Preview + Development**. Each injects its own `BLOB_READ_WRITE_TOKEN` |
| `PRODUCTION_BLOB_STORE_ID` | `store_wIWFdLVUkOUhtb05` in all environments: previews refuse to run against the production store (ADR 0014) |
| `AUTH_SECRET` | random, sensitive, **different** for Production and Preview (never displayed) |
| `ALLOWED_GITHUB_LOGINS` | `lyonsv:2531232` (Production, Preview) |
| `PUBLIC_URL` | `https://margin-sync.vercel.app` (Production). Preview: unset, derived from `VERCEL_URL` |
| Deployment protection | on (Vercel Authentication for previews). The production alias is reachable directly; the app's own sign-in protects it |
| Preview deployment | `https://margin-sync-jjkgath9s-vincent-lyons-projects-fe5e48fc.vercel.app`: every route answers a generic `500 {"error":"server_error"}` because the GitHub variables are missing (fail closed) |
| Production | an **unintended** first deployment (the CLI sends a project's first deploy to production); it crashes at startup and exposes nothing. Your `--prod` deploy below replaces it |

**Left for you**
1. Create the production OAuth App (§2) with callback `https://margin-sync.vercel.app/api/auth/github/callback`.
2. Add its credentials. Each command prompts for the value; nothing lands in shell history:
   ```sh
   npx vercel@latest env add GITHUB_CLIENT_ID production
   npx vercel@latest env add GITHUB_CLIENT_SECRET production --sensitive
   ```
   Previews only need these if you want GitHub sign-in on a preview. A preview's callback is its own URL, which changes per deployment, so normally skip this. If you do want them:
   `npx vercel@latest env add GITHUB_CLIENT_ID preview` and `npx vercel@latest env add GITHUB_CLIENT_SECRET preview --sensitive` (with a separate OAuth App whose callback matches that preview URL).
3. Deploy production from the repo root:
   ```sh
   npx vercel@latest deploy --prod
   ```
4. Check it: `curl -s https://margin-sync.vercel.app/api/me` → `401 {"error":"unauthorized"}`. Then use Margin › Sign In… in the packaged app (it defaults to production; a dev build needs `MARGIN_SERVER_URL=https://margin-sync.vercel.app`).

**Sync errors** ("the server's copy … is older than this Mac's"): see [sync-recovery.md](sync-recovery.md).

**Checking real-Blob behaviour** (no deploy needed): `pnpm --filter @margin/server verify:blob`. It pulls the Preview env (so it uses the **preview** store, never production) into the git-ignored `apps/server/.env.blob.local`, runs every storage assumption against the real store under a throwaway prefix (10 parallel writers for the CAS checks), and deletes what it wrote. Expect `19/19 checks passed`.

## Revoking a device
- **From the app:** Margin › Account and Devices… › **Revoke** (click twice to confirm). Revoking the device you're on signs it out. Margin › Sign Out revokes the current device.
- **Lost all devices:** sign in again on any machine (a new device), then revoke the old ones. To cut off *everything* immediately, remove your entry from `ALLOWED_GITHUB_LOGINS` and redeploy: every request is re-checked against the allowlist. Put it back and sign in again afterwards.
- **By hand:** in the Blob store, delete `auth/devices/<id>.json` (or the whole `auth/devices/` prefix). With the API: `curl -X DELETE -H "Authorization: Bearer <a valid token>" https://<domain>/api/devices/<id>`.

Tokens expire 90 days after their last use.
