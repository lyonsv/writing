# 0014. Vercel deployment: project settings, vercel.json, environments

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
The M4/M5 server (`apps/server`, Hono) is deployed to the owner's personal Vercel account as project **`margin-sync`** (scope `vincent-lyons-projects-fe5e48fc`). The repo is a pnpm workspace, and the server has a dev-only dependency on `@margin/core` (types). Storage is a private Vercel Blob store. Production must not go live until the owner adds the GitHub OAuth secrets.

## Decision
- **Project settings** (set with `vercel project update`): Root Directory **`apps/server`**, framework **Hono**, Node.js **24.x**, Fluid Compute on. The repo root is linked (`.vercel/`, git-ignored), so CLI deploys upload the whole workspace. Vercel installs with pnpm from the workspace root (the lockfile is there) and builds `apps/server`, finding `src/index.ts` (default-exported Hono app) by zero-config detection. No build script, no `api/` folder, no rewrites.
- **`apps/server/vercel.json`, not `vercel.ts`:** the config is three static keys (`framework: "hono"`, `fluid: true`, `regions: ["iad1"]`, the same region as the Blob store). `vercel.ts` would add a dependency (`@vercel/config`) and a build-time evaluation step for no gain. Revisit if config needs logic.
- **Storage:** private Blob store **`margin-store`** (`store_wIWFdLVUkOUhtb05`, iad1), connected to the project for Production and Preview. The connection injects `BLOB_READ_WRITE_TOKEN`, which `storeFromEnv` uses. Each deployment's functions use that store; previews and production **share** it (one personal store), so a preview signed in by the owner sees the real documents.
- **Environment variables:**

  | Variable | Production | Preview | Notes |
  |---|---|---|---|
  | `BLOB_READ_WRITE_TOKEN` | from the store connection | same | |
  | `AUTH_SECRET` | random, sensitive | **different** random, sensitive | generated with `openssl rand -base64 48`, piped into `vercel env add`, never displayed |
  | `ALLOWED_GITHUB_LOGINS` | `lyonsv:2531232` | same | |
  | `PUBLIC_URL` | `https://margin-sync.vercel.app` | **unset** | previews derive `https://$VERCEL_URL` (below) |
  | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | **owner** adds | optional | until then every route returns the generic 500 (fail closed) |

  Separate `AUTH_SECRET`s mean preview sessions and tokens are useless against production, and the reverse.
- **Preview `PUBLIC_URL`:** `loadConfig` falls back to `https://$VERCEL_URL`, but **only when `VERCEL_ENV=preview`** and `PUBLIC_URL` is unset. Both are set by Vercel; `VERCEL_URL` must be a bare hostname. Production never falls back, so a missing value fails closed. GitHub sign-in on a preview also needs an OAuth App whose callback is that preview's URL; previews are mainly smoke tests.
- **Production alias:** `margin-sync.vercel.app`, already registered on the project.
- **Deployment protection** stays **on** (Vercel Authentication, `all_except_custom_domains`). We test previews with `vercel curl`, which carries an automation bypass, and never disable protection. **Consequence for M8:** `margin-sync.vercel.app` is a `*.vercel.app` domain, so it's protected too, and the desktop app can't reach it through Vercel Authentication. Before real use the owner must either add a custom domain (protection excludes custom domains with this setting) or deliberately change production protection. The app has its own auth (ADRs 0010–0012) on every route.

## Consequences
- Deploys: `npx vercel@latest deploy` (preview) from the repo root. Production is the owner's call: `npx vercel@latest deploy --prod`.
- Real-Blob behaviour is checked by `pnpm --filter @margin/server verify:blob` (ADR 0012/0013 amendments), not by `pnpm test`.
