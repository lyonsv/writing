import { createHash } from 'node:crypto';

import { PreconditionFailedError, StoreBusyError, type KeyValueStore, type PutOptions, type StoredItem } from './store.js';

/**
 * `KeyValueStore` on a private GitHub repository, via the REST Contents API
 * (ADR 0021). One file per key on one branch; every write is a commit.
 *
 * - **Versions (ETags)** are git blob SHAs. They're content-derived, like Blob's
 *   were, and computed locally from the bytes (`sha1("blob <len>\0" + bytes)`), so
 *   one raw read gives both the content and the exact `sha` a conditional write
 *   needs.
 * - **Reads** use the raw media type (works up to 100 MB, beyond the 1 MB JSON
 *   limit), with `If-None-Match` on the last HTTP ETag per key: a 304 doesn't
 *   count against the rate limit and returns the cached bytes. Node's fetch has
 *   no HTTP cache, and we send `Cache-Control: no-cache` as well.
 * - **Compare-and-swap:** `ifMatch` → `PUT` with `sha`; `create` → `PUT` without
 *   `sha` (GitHub refuses if the file exists).
 * - **Failures are classified by state, not message.** GitHub answers both a real
 *   sha mismatch and a lost race on the branch head (two commits at once) with
 *   409/422. After such a failure we re-read the file's sha. If it contradicts
 *   the condition (different sha for ifMatch; present for create), it's a
 *   `PreconditionFailedError`. If it still satisfies the condition, the write
 *   lost a branch-head race and is retried with jitter. A real mismatch is never
 *   turned into a success.
 */

export interface GitHubStoreOptions {
  /** Fine-grained PAT with Contents read/write on this one repository. */
  token: string;
  /** `owner/name` */
  repo: string;
  branch: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** API origin; default https://api.github.com. */
  apiUrl?: string;
  /** Retries for branch-head races (default 8). */
  maxRaceRetries?: number;
}

export class GitHubStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubStoreError';
  }
}

/** The git blob SHA-1 of `bytes`: the `sha` GitHub reports for a file with this content. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const quote = (sha: string) => `"${sha}"`;
const unquote = (etag: string) => etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

export class GitHubStore implements KeyValueStore {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly api: string;
  /** Last raw response per key (HTTP ETag → bytes), for conditional GETs. */
  private readonly cache = new Map<string, { httpEtag: string; bytes: Uint8Array }>();
  /** Calls made (tests and the verification script count them). */
  calls = 0;

  constructor(private readonly options: GitHubStoreOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new Error('GitHubStore: repo must be owner/name');
    if (!options.branch || !options.token) throw new Error('GitHubStore: token and branch are required');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.api = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private url(key: string, query = true): string {
    if (!key || key.startsWith('/') || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`GitHubStore: bad key ${JSON.stringify(key)}`);
    }
    const path = key.split('/').map(encodeURIComponent).join('/');
    const base = `${this.api}/repos/${this.options.repo}/contents/${path}`;
    return query ? `${base}?ref=${encodeURIComponent(this.options.branch)}` : base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Margin',
      'Cache-Control': 'no-cache',
      ...extra,
    };
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    this.calls++;
    const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const busy = await rateLimited(res);
    if (busy !== null) throw new StoreBusyError(busy);
    return res;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new GitHubStoreError(`GitHub ${what} failed: HTTP ${res.status} ${body}`, res.status);
  }

  // ------------------------------------------------------------------ reads

  async getBytes(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const cached = this.cache.get(key);
    const res = await this.call(this.url(key), {
      headers: this.headers({ Accept: 'application/vnd.github.raw', ...(cached ? { 'If-None-Match': cached.httpEtag } : {}) }),
    });
    if (res.status === 304 && cached) return { bytes: cached.bytes.slice(), etag: quote(gitBlobSha(cached.bytes)) };
    if (res.status === 404) {
      this.cache.delete(key);
      return null;
    }
    if (!res.ok) return this.fail(res, `read ${key}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const httpEtag = res.headers.get('ETag');
    // Cache small values only (manifest, device records); document bodies are immutable
    // and large, so re-reading them is rare and caching them would only cost memory.
    if (httpEtag && bytes.length <= 1024 * 1024) {
      this.cache.delete(key);
      this.cache.set(key, { httpEtag, bytes: bytes.slice() });
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    }
    return { bytes, etag: quote(gitBlobSha(bytes)) };
  }

  async get(key: string): Promise<StoredItem | null> {
    const got = await this.getBytes(key);
    return got ? { value: dec.decode(got.bytes), etag: got.etag } : null;
  }

  /** The file's current blob sha, or null if it doesn't exist (a cheap conditional read). */
  private async currentSha(key: string): Promise<string | null> {
    const got = await this.getBytes(key);
    return got ? unquote(got.etag) : null;
  }

  /** Every key starting with `prefix` (recursive), from one Git Trees API call. */
  async list(prefix: string): Promise<string[]> {
    const url = `${this.api}/repos/${this.options.repo}/git/trees/${encodeURIComponent(this.options.branch)}?recursive=1`;
    const res = await this.call(url, { headers: this.headers({ Accept: 'application/vnd.github+json' }) });
    if (res.status === 404 || res.status === 409) return []; // 409: empty repository
    if (!res.ok) return this.fail(res, 'list');
    const body = (await res.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
    if (body.truncated) throw new GitHubStoreError('GitHub tree listing truncated (repository too large to list)', 500);
    return (body.tree ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => e.path).sort();
  }

  // ------------------------------------------------------------------ writes

  async put(key: string, value: string, options: PutOptions = {}): Promise<{ etag: string }> {
    return this.putBytes(key, enc.encode(value), options);
  }

  async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<{ etag: string }> {
    const retries = this.options.maxRaceRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      let sha: string | undefined;
      if (options.ifMatch !== undefined) {
        sha = unquote(options.ifMatch);
        // GitHub ignores `sha` when the file doesn't exist and creates it (verified
        // against the real API), so check first: a missing or changed file is a
        // precondition failure. Usually a free 304. A delete landing between this check and
        // the PUT could still be undone by the PUT; nothing in Margin deletes a key
        // it also compare-and-swaps (ADR 0021).
        if ((await this.currentSha(key)) !== sha) throw new PreconditionFailedError();
      }
      else if (!options.create) sha = (await this.currentSha(key)) ?? undefined; // unconditional overwrite
      const res = await this.call(this.url(key, false), {
        method: 'PUT',
        headers: this.headers({ Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: `margin: ${sha ? 'update' : 'create'} ${key} [skip ci]`,
          content: Buffer.from(bytes).toString('base64'),
          branch: this.options.branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { content?: { sha?: string } };
        const newSha = body.content?.sha ?? gitBlobSha(bytes);
        this.cache.delete(key);
        return { etag: quote(newSha) };
      }
      if (res.status !== 409 && res.status !== 422 && !(res.status === 404 && sha)) return this.fail(res, `write ${key}`);
      await res.text().catch(() => '');
      // Classify by state: does the file still satisfy our condition?
      const now = await this.currentSha(key);
      if (options.ifMatch !== undefined && now !== unquote(options.ifMatch)) throw new PreconditionFailedError();
      if (options.create && now !== null) throw new PreconditionFailedError();
      // Unconditional overwrite whose sha went stale: just retry with the new one.
      // Otherwise the condition still holds, so we lost a race on the branch head: retry.
      if (attempt >= retries) throw new GitHubStoreError(`GitHub write ${key}: branch busy after ${retries} retries`, 409);
      await jitter(attempt);
    }
  }

  async delete(key: string): Promise<void> {
    const retries = this.options.maxRaceRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      const sha = await this.currentSha(key);
      if (sha === null) return; // deleting a missing key is not an error
      const res = await this.call(this.url(key, false), {
        method: 'DELETE',
        headers: this.headers({ Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: `margin: delete ${key} [skip ci]`, sha, branch: this.options.branch }),
      });
      if (res.ok || res.status === 404) {
        this.cache.delete(key);
        return;
      }
      if (res.status !== 409 && res.status !== 422) return this.fail(res, `delete ${key}`);
      if (attempt >= retries) throw new GitHubStoreError(`GitHub delete ${key}: branch busy after ${retries} retries`, 409);
      await jitter(attempt);
    }
  }
}

/**
 * GitHub's rate limiting, per its docs: 429, or 403 with `retry-after`,
 * `x-ratelimit-remaining: 0`, or a "rate limit" message (secondary limits). Returns
 * the seconds to wait, or null if this isn't a rate-limit response. (A plain 403
 * is a permissions error and is left alone.)
 */
async function rateLimited(res: Response): Promise<number | null> {
  if (res.status !== 429 && res.status !== 403) return null;
  const retryAfter = Number(res.headers.get('retry-after'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  let limited = res.status === 429 || (Number.isFinite(retryAfter) && res.headers.has('retry-after')) || remaining === '0';
  if (!limited) {
    const text = await res.clone().text().catch(() => '');
    limited = /rate limit/i.test(text);
  }
  if (!limited) return null;
  if (res.headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.ceil(retryAfter);
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60; // GitHub: wait at least a minute after a secondary limit with no hint
}

function jitter(attempt: number): Promise<void> {
  const cap = Math.min(2_000, 50 * 2 ** Math.min(attempt, 6));
  return new Promise((r) => setTimeout(r, cap / 2 + Math.random() * cap));
}
