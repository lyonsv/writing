import { createHash } from 'node:crypto';

/**
 * A faithful-enough fake of GitHub's REST Contents API for one repo, used to run
 * the server's suites against `GitHubStore` (ADR 0021). It models what the store
 * relies on:
 * - `GET /repos/{o}/{r}/contents/{path}?ref=` with `Accept: application/vnd.github.raw`
 *   → raw bytes + an HTTP ETag; `If-None-Match` → 304; missing → 404;
 *   a directory with the JSON media type → an array of entries.
 * - `PUT` with `content` (base64) and optional `sha`: create without `sha` on an
 *   existing file → 422 ("sha wasn't supplied"); a `sha` that doesn't match an
 *   existing file → 409; a `sha` for a missing file is IGNORED and the file is
 *   created (as real GitHub does); success → `{ content: { sha } }`.
 * - `DELETE` with `sha` (404 missing, 409 mismatch).
 * - **Branch-head races:** with `raceRate > 0`, a write randomly fails with 409
 *   "is at X but expected Y" and changes nothing, like two commits racing on the ref.
 * Every call yields first, so concurrent callers interleave. Requires the token
 * and the configured branch.
 */
export function fakeGitHubContents(opts: { repo?: string; branch?: string; token?: string; raceRate?: number } = {}) {
  const repo = opts.repo ?? 'owner/library';
  const branch = opts.branch ?? 'preview';
  const token = opts.token ?? 'test-token';
  const files = new Map<string, Uint8Array>();
  const stats = { calls: 0, writes: 0, races: 0, notModified: 0, commits: 0 };
  let raceRate = opts.raceRate ?? 0;
  /** Deterministic: the next N writes lose a branch-head race. */
  let forcedRaces = 0;
  /** Runs right before a write is applied (to change state underneath it). */
  let beforeWrite: ((path: string) => void) | undefined;
  const blobSha = (b: Uint8Array) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function handler(input: string, init: RequestInit = {}): Promise<Response> {
    stats.calls++;
    await tick();
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    const treePath = `/repos/${repo}/git/trees/${encodeURIComponent(branch)}`;
    if (url.pathname === treePath && (init.method ?? 'GET') === 'GET') {
      if (url.searchParams.get('recursive') !== '1') return json(422, { message: 'expected recursive=1' });
      const dirs = new Set<string>();
      for (const k of files.keys()) {
        const parts = k.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return json(200, {
        tree: [
          ...[...dirs].map((path) => ({ path, type: 'tree' })),
          ...[...files.entries()].map(([path, b]) => ({ path, type: 'blob', sha: blobSha(b) })),
        ],
        truncated: false,
      });
    }
    const prefix = `/repos/${repo}/contents/`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const path = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    const method = init.method ?? 'GET';

    if (method === 'GET') {
      if (url.searchParams.get('ref') !== branch) return json(404, { message: 'No commit found for the ref' });
      const file = files.get(path);
      if (!file) {
        const children = [...files.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'));
        if (children.length && !headers.get('Accept')?.includes('raw')) {
          return json(200, children.sort().map((k) => ({ name: k.split('/').pop(), path: k, type: 'file', sha: blobSha(files.get(k)!) })));
        }
        return json(404, { message: 'Not Found' });
      }
      const etag = `"${createHash('sha256').update(path).update(file).digest('hex').slice(0, 40)}"`;
      if (headers.get('If-None-Match') === etag) {
        stats.notModified++;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(file.slice(), { status: 200, headers: { ETag: etag, 'Content-Type': 'application/octet-stream' } });
    }

    const body = JSON.parse(String(init.body ?? '{}')) as { content?: string; sha?: string; branch?: string; message?: string };
    if (body.branch !== branch) return json(422, { message: 'branch mismatch' });
    if (!body.message) return json(422, { message: 'message is required' });
    stats.writes++;
    if (forcedRaces > 0 || Math.random() < raceRate) {
      if (forcedRaces > 0) forcedRaces--;
      stats.races++;
      return json(409, { message: `refs/heads/${branch} is at aaaa but expected bbbb` });
    }
    beforeWrite?.(path);
    const current = files.get(path);
    if (method === 'PUT') {
      if (current && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      // Real GitHub (verified with verify:github): a `sha` for a file that doesn't exist is
      // ignored and the file is created. Only an existing file's sha is checked.
      if (body.sha && current && blobSha(current) !== body.sha) return json(409, { message: `${path} does not match ${body.sha}` });
      const bytes = new Uint8Array(Buffer.from(body.content ?? '', 'base64'));
      files.set(path, bytes);
      stats.commits++;
      return json(current ? 200 : 201, { content: { path, sha: blobSha(bytes) }, commit: { sha: 'c' } });
    }
    if (method === 'DELETE') {
      if (!current) return json(404, { message: 'Not Found' });
      if (body.sha !== blobSha(current)) return json(409, { message: `${path} does not match ${body.sha}` });
      files.delete(path);
      stats.commits++;
      return json(200, { commit: { sha: 'c' } });
    }
    return json(405, { message: 'Method not allowed' });
  }

  return {
    fetch: handler,
    files,
    stats,
    repo,
    branch,
    token,
    setRaceRate: (r: number) => (raceRate = r),
    forceRaces: (n: number) => (forcedRaces = n),
    onBeforeWrite: (fn: ((path: string) => void) | undefined) => (beforeWrite = fn),
  };
}
