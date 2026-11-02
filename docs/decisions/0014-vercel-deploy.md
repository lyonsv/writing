# 0014. Vercel deployment: project settings, vercel.json, environments

- **Status:** Accepted
- **Date:** 2026-11-02

## Context
The M4/M5 server (`apps/server`, Hono) is deployed to the owner's personal Vercel account as project **`margin-sync`** (scope `vincent-lyons-projects-fe5e48fc`). The repo is a pnpm workspace, and the server has a dev-only dependency on `@margin/core` (types). Storage is a private Vercel Blob store. Production must not go live until the owner adds the GitHub OAuth secrets.

## Decision
- **Project settings** (set with `vercel project update`): Root Directory **`apps/server`**, framework **Hono**, Node.js **24.x**, Fluid Compute on. The repo root is linked (`.vercel/`, git-ignored), so CLI deploys upload the whole workspace. Vercel installs with pnpm from the workspace root (the lockfile is there) and builds `apps/server`, finding **`apps/server/server.ts`** (default-exported Hono app) by zero-config detection. No build script, no `api/` folder, no rewrites.
- **Learned on the first deploys:** (1) Vercel compiles each TS file without bundling and runs it as native ESM, so relative imports need `.js` extensions (`./codes.js`); extensionless ones crash with `ERR_MODULE_NOT_FOUND` (a unit test now rejects them). (2) Vercel's entrypoint detection picked `src/app.ts` (the app *factory*, no default export) even with `server.ts` present, so the factory is now `src/createApp.ts` and **`server.ts` is the only file matching Vercel's entry names** (`app|index|server|main` at the root or in `src/`). Keep it that way; a unit test checks `server.ts` default-exports the app. (3) Without `engines.node` in `apps/server/package.json` the runtime followed the root's `>=22` to Node 26 despite the 24.x project setting, so it's pinned to `24.x` (pnpm prints an engine warning on older local Node; harmless).
- **`apps/server/vercel.json`, not `vercel.ts`:** the config is three static keys (`framework: "hono"`, `fluid: true`, `regions: ["iad1"]`, the same region as the Blob store). `vercel.ts` would add a dependency (`@vercel/config`) and a build-time evaluation step for no gain. Revisit if config needs logic.
- **Storage: one private Blob store per environment class** (amended after validation; previews used to share the production store, so untested branch code could corrupt real documents):

  | Store | Id | Connected to |
  |---|---|---|
  | `margin-store` | `store_wIWFdLVUkOUhtb05` | **Production only** |
  | `margin-store-preview` | `store_RCqGVGmwoZxS2m4D` | **Preview and Development** |

  Both are private, in iad1. Each connection injects its own `BLOB_READ_WRITE_TOKEN`, verified to differ per environment by comparing token hashes and the store id each embeds, without printing them. The production connection was narrowed with the same API call the CLI uses (`PATCH /v1/storage/stores/{id}/connections/{connectionId}` with `envVarEnvironments: ["production"]`).
- **Guard (defence in depth):** `PRODUCTION_BLOB_STORE_ID=store_wIWFdLVUkOUhtb05` is set in every environment. On Vercel outside production, `loadConfig` refuses to run, which means the generic 500 on every request, if that variable is missing, if the deployment's Blob store can't be identified (from `BLOB_STORE_ID` or the store id embedded in the read-write token), or if it is the production store. Unit tests cover each case.
- **Environment variables:**

  | Variable | Production | Preview | Notes |
  |---|---|---|---|
  | `BLOB_READ_WRITE_TOKEN` | `margin-store` connection | `margin-store-preview` connection (also Development) | different stores |
  | `PRODUCTION_BLOB_STORE_ID` | `store_wIWFdLVUkOUhtb05` | same | not secret; enables the guard |
  | `AUTH_SECRET` | random, sensitive | **different** random, sensitive | generated with `openssl rand -base64 48`, piped into `vercel env add`, never displayed |
  | `ALLOWED_GITHUB_LOGINS` | `lyonsv:2531232` | same | |
  | `PUBLIC_URL` | `https://margin-sync.vercel.app` | **unset** | previews derive `https://$VERCEL_URL` (below) |
  | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | **owner** adds | optional | until then every route returns the generic 500 (fail closed) |

  Separate `AUTH_SECRET`s mean preview sessions and tokens are useless against production, and the reverse.
- **Preview `PUBLIC_URL`:** `loadConfig` falls back to `https://$VERCEL_URL`, but **only when `VERCEL_ENV=preview`** and `PUBLIC_URL` is unset. Both are set by Vercel; `VERCEL_URL` must be a bare hostname. Production never falls back, so a missing value fails closed. GitHub sign-in on a preview also needs an OAuth App whose callback is that preview's URL; previews are mainly smoke tests.
- **Production alias:** `margin-sync.vercel.app`, already registered on the project.
- **Deployment protection** stays **on**: Vercel Authentication, `all_except_custom_domains` (Standard Protection). Verified: preview and per-deployment URLs answer `302` to Vercel SSO without credentials. **The production alias `margin-sync.vercel.app` is *not* behind Vercel Authentication** under this setting, as observed: it answers directly. That is what real clients need, and the app's own auth (ADRs 0010–0012) protects every route. We check previews with `vercel curl`, which carries an automation bypass, and never disable protection.
- **An unintended production deployment happened.** The CLI assigns a project's *first* deployment to production even without `--prod`. Our first `vercel deploy` (a build that crashed at startup, `FUNCTION_INVOCATION_FAILED`) therefore became production and is served at `margin-sync.vercel.app`. It exposes nothing (every request is a 500 with no details), and the owner's first `vercel deploy --prod` replaces it. To remove it sooner: `npx vercel@latest remove <that deployment URL>` (listed with `vercel ls`).

## Consequences
- Deploys: `npx vercel@latest deploy` (preview) from the repo root. Production is the owner's call: `npx vercel@latest deploy --prod`.
- Real-Blob behaviour is checked by `pnpm --filter @margin/server verify:blob` (ADR 0012/0013 amendments), not by `pnpm test`. It pulls the **Preview** environment, so it runs against `margin-store-preview` and never touches production data.
- Recovery from a rolled-back store: `docs/sync-recovery.md` and Margin › Reset Sync State for This Folder…

## Amendments (2026-11-02, M8: the web app on the same project)
- `vercel.json` gains `buildCommand: "pnpm run build:web"` (Expo web export, then `scripts/stage-web.mjs`) and cache headers. The build writes `apps/server/public/` (static files for the CDN) and `apps/server/web/index.html` (the shell, read by `server.ts` and only sent to signed-in browsers). Both are git-ignored build outputs. ADR 0020 has the design.
- The Vercel build therefore needs the whole workspace installed (Expo and Metro for the export). It already installs from the root lockfile.
- **To confirm on the first deploy:** `/` returns the sign-in page (401) when signed out; `/_expo/static/...` comes from the CDN; `/index.html` is not served publicly; `/api/me` is unchanged.
