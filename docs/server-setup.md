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
The desktop app talks to `http://127.0.0.1:3000` by default. To point it elsewhere, set `MARGIN_SERVER_URL`, or add `"serverUrl": "https://<your-domain>"` to `settings.json` in the app's userData folder (`~/Library/Application Support/Margin/` when packaged).

## 5. Production on Vercel (M8; not done in M4)
1. Create a **private** Blob store and connect it to the project. Access mode can't be changed later. Use the dashboard (Storage › Blob › Create, access *Private*) or `vercel blob create-store margin --access private`.
2. Create the Vercel project from this repo with **Root Directory `apps/server`**. Hono is detected automatically, Node.js runtime, Fluid Compute on (`apps/server/vercel.json`).
3. Set `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (production OAuth App), `ALLOWED_GITHUB_LOGINS` and `AUTH_SECRET` as **Production** env vars. Preview deployments need their own OAuth App and `PUBLIC_URL`, or should be left without auth vars, so they fail closed.
4. Deploy, then check: `curl -i https://<domain>/api/me` → `401`, and `/api/auth/native/start` without parameters → `400`.
5. First real sign-in: confirm GitHub accepts the PKCE parameters (`code_challenge`) for your OAuth App. If the token exchange fails, the logs show `signin.github_failed`.

## Revoking a device
- **From the app:** Margin › Account and Devices… › **Revoke** (click twice to confirm). Revoking the device you're on signs it out. Margin › Sign Out revokes the current device.
- **Lost all devices:** sign in again on any machine (a new device), then revoke the old ones. To cut off *everything* immediately, remove your entry from `ALLOWED_GITHUB_LOGINS` and redeploy: every request is re-checked against the allowlist. Put it back and sign in again afterwards.
- **By hand:** in the Blob store, delete `auth/devices/<id>.json` (or the whole `auth/devices/` prefix). With the API: `curl -X DELETE -H "Authorization: Bearer <a valid token>" https://<domain>/api/devices/<id>`.

Tokens expire 90 days after their last use.
