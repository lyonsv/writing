import { SyncPreconditionError, SyncRejectedError, type RemoteEntry, type SyncRemote } from './sync';

/**
 * The sync API client (ADR 0013), shared by the desktop main process and iOS.
 * Transport-agnostic: the platform supplies an authenticated `request` (which
 * adds the bearer token, refuses redirects and handles 401). Only the bits of
 * a fetch `Response` we need, so no DOM types leak into core.
 */
export interface SyncHttpResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type SyncHttpRequest = (
  method: string,
  pathname: string,
  init?: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number },
) => Promise<SyncHttpResponse>;

/**
 * The server (or its storage) is rate-limited: 503/429, usually with
 * `Retry-After`. Sync runs stop and the client waits (`SyncBackoff`).
 */
export class SyncBusyError extends Error {
  constructor(readonly retryAfterMs: number | undefined) {
    super('server busy');
    this.name = 'SyncBusyError';
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Undefined if absent or invalid. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * When to try again after the server said "busy": the longer of the server's
 * `Retry-After` and an exponential backoff (30 s, 60 s, 2 min… capped at 30 min,
 * ±20% jitter), so repeated limits back off further. Success resets it. Shared by the desktop and web
 * clients; pure, with an injectable clock and randomness.
 */
export class SyncBackoff {
  private failures = 0;
  private until = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly baseMs = 30_000,
    private readonly maxMs = 30 * 60_000,
  ) {}

  /** Record a busy/failed run. Returns the wait in ms. */
  fail(retryAfter?: number): number {
    this.failures++;
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
    const jittered = exp * (0.8 + 0.4 * this.random());
    // Never sooner than the server asked; and repeated failures still back off further.
    const wait = Math.min(this.maxMs, Math.max(retryAfter ?? 0, jittered));
    this.until = this.now() + wait;
    return wait;
  }

  succeed(): void {
    this.failures = 0;
    this.until = 0;
  }

  /** Milliseconds left before another run should start (0 = go). */
  waitMs(): number {
    return Math.max(0, this.until - this.now());
  }
}

export class HttpSyncRemote implements SyncRemote {
  constructor(private readonly request: SyncHttpRequest) {}

  private async check(res: SyncHttpResponse): Promise<SyncHttpResponse> {
    if (res.ok) return res;
    if (res.status === 503 || res.status === 429) throw new SyncBusyError(retryAfterMs(res.headers.get('Retry-After')));
    if (res.status === 412 || res.status === 409) throw new SyncPreconditionError(`HTTP ${res.status}`);
    if (res.status === 413) throw new SyncRejectedError('too large to sync (over 4 MB)');
    if (res.status === 400) throw new SyncRejectedError('name not supported by sync');
    throw new Error(`server error ${res.status}`);
  }

  private q(p: string) {
    return `?path=${encodeURIComponent(p)}`;
  }

  async manifest(): Promise<{ seq?: number; entries: RemoteEntry[] }> {
    const res = await this.check(await this.request('GET', '/api/sync/manifest'));
    const body = (await res.json()) as { seq?: unknown; entries: RemoteEntry[] };
    return { seq: typeof body.seq === 'number' ? body.seq : undefined, entries: body.entries };
  }

  async get(p: string) {
    const res = await this.request('GET', `/api/sync/file${this.q(p)}`, { timeoutMs: 60_000 });
    if (res.status === 404) return null;
    if (res.status === 503 || res.status === 429) throw new SyncBusyError(retryAfterMs(res.headers.get('Retry-After')));
    await this.check(res);
    const entry = JSON.parse(decodeURIComponent(res.headers.get('X-Margin-Entry') ?? '')) as RemoteEntry;
    return { bytes: new Uint8Array(await res.arrayBuffer()), entry };
  }

  async put(p: string, bytes: Uint8Array, ifMatch: string | null): Promise<RemoteEntry> {
    const res = await this.request('PUT', `/api/sync/file${this.q(p)}`, {
      body: bytes,
      headers: ifMatch === null ? { 'If-None-Match': '*' } : { 'If-Match': `"${ifMatch}"` },
      timeoutMs: 60_000,
    });
    return ((await (await this.check(res)).json()) as { entry: RemoteEntry }).entry;
  }

  async delete(p: string, ifMatch: string): Promise<void> {
    await this.check(await this.request('DELETE', `/api/sync/file${this.q(p)}`, { headers: { 'If-Match': `"${ifMatch}"` } }));
  }

  async move(from: string, to: string, ifMatch: string): Promise<RemoteEntry> {
    const res = await this.request('POST', '/api/sync/move', { json: { from, to, ifMatch } });
    return ((await (await this.check(res)).json()) as { entry: RemoteEntry }).entry;
  }
}
