/**
 * Real GitHub storage verification (`pnpm --filter @margin/server verify:github`).
 * NOT part of `pnpm test`: it talks to the real repository (ADR 0021).
 *
 * - Loads apps/server/.env.verify (git-ignored): GITHUB_STORE_TOKEN,
 *   GITHUB_STORE_REPO, GITHUB_STORE_BRANCH. The token is never printed.
 * - Runs ONLY against the `preview` branch, and refuses anything else.
 * - Budget: at most 90 API calls (aborts beyond that); typically ~45.
 * - Writes under a throwaway prefix `verify-<random>/` and deletes it at the end.
 *
 * Checks: create-only; read-after-write; conditional read → 304; concurrent CAS
 * with N=5 (exactly one winner); ifMatch on a deleted key; raw read of a 2 MB file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { GitHubStore } from '../src/githubStore';
import { PreconditionFailedError } from '../src/store';

const envFile = path.resolve(import.meta.dirname, '../.env.verify');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const token = process.env.GITHUB_STORE_TOKEN;
const repo = process.env.GITHUB_STORE_REPO;
const branch = process.env.GITHUB_STORE_BRANCH;
if (!token || !repo || !branch) {
  console.error('Set GITHUB_STORE_TOKEN, GITHUB_STORE_REPO and GITHUB_STORE_BRANCH (apps/server/.env.verify)');
  process.exit(2);
}
if (branch !== 'preview') {
  console.error(`Refusing to run against branch "${branch}": verify:github only runs on "preview".`);
  process.exit(2);
}

const BUDGET = 90;
let calls = 0;
let notModified = 0;
const counted = async (input: string, init?: RequestInit) => {
  if (++calls > BUDGET) throw new Error(`API call budget (${BUDGET}) exceeded`);
  const res = await fetch(input, init);
  if (res.status === 304) notModified++;
  return res;
};
const store = new GitHubStore({ token, repo, branch, fetch: counted, maxRaceRetries: 6 });
const prefix = `verify-${randomBytes(4).toString('hex')}/`;
const written = new Set<string>();
const results: Array<{ check: string; ok: boolean; observed: string }> = [];
const record = (check: string, ok: boolean, observed: string) => {
  results.push({ check, ok, observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}\n      ${observed}`);
};
const errName = (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 140)}` : String(e));
const k = (name: string) => {
  const key = `${prefix}${name}`;
  written.add(key);
  return key;
};

async function main() {
  console.log(`target: ${repo}@${branch} (prefix ${prefix})`);

  // 1. Create-only.
  {
    const key = k('create.json');
    await store.put(key, '"first"', { create: true });
    let err: unknown = null;
    await store.put(key, '"second"', { create: true }).catch((e: unknown) => (err = e));
    const kept = (await store.get(key))?.value;
    record('create-only on an existing file → PreconditionFailed, file untouched', err instanceof PreconditionFailedError && kept === '"first"', `error=${errName(err)} kept=${kept}`);
  }

  // 2. Read-after-write (3 rounds) and 3. a conditional re-read is a 304.
  {
    const key = k('raw.json');
    let { etag } = await store.put(key, '0', { create: true });
    let fresh = 0;
    for (let i = 1; i <= 3; i++) {
      ({ etag } = await store.put(key, String(i), { ifMatch: etag }));
      const got = await store.get(key);
      if (got?.value === String(i) && got.etag === etag) fresh++;
    }
    record('read-after-write returns the new value and sha immediately (3/3)', fresh === 3, `fresh=${fresh}/3`);
    const before = notModified;
    const again = await store.get(key);
    record('an unchanged re-read is a 304 (not counted against the rate limit)', notModified === before + 1 && again?.value === '3', `304s=${notModified - before} value=${again?.value}`);
  }

  // 4. Concurrent CAS, N=5.
  {
    const key = k('cas.json');
    const { etag } = await store.put(key, '"base"', { create: true });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => store.put(key, JSON.stringify(`w${i}`), { ifMatch: etag })));
    const wins = outcomes.filter((o) => o.status === 'fulfilled').length;
    const pre = outcomes.filter((o) => o.status === 'rejected' && (o as PromiseRejectedResult).reason instanceof PreconditionFailedError).length;
    const other = outcomes.filter((o) => o.status === 'rejected' && !((o as PromiseRejectedResult).reason instanceof PreconditionFailedError)).map((o) => errName((o as PromiseRejectedResult).reason));
    const final = (await store.get(key))?.value;
    const winner = outcomes.findIndex((o) => o.status === 'fulfilled');
    record('5 concurrent ifMatch writes → exactly one winner, 4 precondition failures, winner stored', wins === 1 && pre === 4 && final === JSON.stringify(`w${winner}`), `wins=${wins} precondition=${pre} other=${JSON.stringify(other)} stored=${final}`);
  }

  // 5. ifMatch on a deleted file.
  {
    const key = k('deleted.json');
    const { etag } = await store.put(key, '"x"', { create: true });
    await store.delete(key);
    let err: unknown = null;
    await store.put(key, '"resurrected"', { ifMatch: etag }).catch((e: unknown) => (err = e));
    const after = await store.get(key);
    record('ifMatch on a deleted file → PreconditionFailed, nothing created', err instanceof PreconditionFailedError && after === null, `error=${errName(err)} exists=${after !== null}`);
  }

  // 6. Raw read of a 2 MB file (beyond the Contents API's 1 MB JSON limit).
  {
    const key = k('big.bin');
    const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 31) % 256);
    await store.putBytes(key, big, { create: true });
    const got = await store.getBytes(key);
    const same = got && createHash('sha256').update(got.bytes).digest('hex') === createHash('sha256').update(big).digest('hex');
    record('2 MB file round-trips byte-exact via the raw media type', !!same, `read ${got?.bytes.length ?? 0} bytes`);
  }
}

try {
  await main();
} catch (error) {
  record('script completed', false, errName(error));
} finally {
  let removed = 0;
  for (const key of written) {
    try {
      await store.delete(key);
      removed++;
    } catch (error) {
      console.error(`cleanup failed for ${key}: ${errName(error)}`);
    }
  }
  console.log(`cleanup: deleted ${removed}/${written.size} file(s) under ${prefix} on ${branch}`);
  console.log(`API calls: ${calls} (budget ${BUDGET}); 304s: ${notModified}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
