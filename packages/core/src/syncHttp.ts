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

export class HttpSyncRemote implements SyncRemote {
  constructor(private readonly request: SyncHttpRequest) {}

  private async check(res: SyncHttpResponse): Promise<SyncHttpResponse> {
    if (res.ok) return res;
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
