import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  SyncPreconditionError,
  SyncRejectedError,
  isSyncablePath,
  runSync,
  type BaseEntry,
  type LocalFile,
  type RemoteEntry,
  type SyncLocal,
  type SyncRemote,
  type SyncReport,
  type SyncStatus,
} from '@margin/core';

import { AccountError, type AccountManager } from './account';
import type { FileSystemLibrary } from './library';

/**
 * Desktop sync (ADR 0013): runs the core engine between the library folder
 * and the server, using the account's token (main process only).
 *
 * When: on start / sign-in, every `intervalMs` (30 s), shortly after local
 * changes (`nudge`, debounced), and on Sync Now. One run at a time; a request
 * during a run schedules one more run afterwards.
 *
 * Safety: before each run the renderers flush (so uploads see what was typed);
 * downloads go through the library's per-path queue with a hash check
 * (`writeForSync`), so they never overwrite text they didn't plan for, and
 * open-document conflicts follow ADR 0006. Local deletes go to the Trash.
 */

export interface SyncServiceOptions {
  library: () => FileSystemLibrary;
  account: AccountManager;
  /** Folder for per-library/per-account sync state, e.g. userData/sync. */
  stateDir: string;
  trash: (absolute: string) => Promise<void>;
  /** Flush editors first; resolve false to skip this run (e.g. a renderer didn't answer). */
  beforeSync?: () => Promise<boolean>;
  onStatus?: (status: SyncStatus) => void;
  intervalMs?: number;
  debounceMs?: number;
}

interface StateFile {
  v: 1;
  serverUrl: string;
  login: string;
  root: string;
  base: Record<string, BaseEntry>;
  /** Hash cache: path → size/mtime/hash, so unchanged files aren't re-read every run. */
  hashes: Record<string, { size: number; mtimeMs: number; hash: string }>;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

class HttpRemote implements SyncRemote {
  constructor(private readonly account: AccountManager) {}

  private async check(res: Response): Promise<Response> {
    if (res.ok) return res;
    if (res.status === 412 || res.status === 409) throw new SyncPreconditionError(`HTTP ${res.status}`);
    if (res.status === 413) throw new SyncRejectedError('too large to sync (over 4 MB)');
    if (res.status === 400) throw new SyncRejectedError('name not supported by sync');
    throw new Error(`server error ${res.status}`);
  }

  private q(p: string) {
    return `?path=${encodeURIComponent(p)}`;
  }

  async manifest(): Promise<RemoteEntry[]> {
    const res = await this.check(await this.account.request('GET', '/api/sync/manifest'));
    return ((await res.json()) as { entries: RemoteEntry[] }).entries;
  }

  async get(p: string) {
    const res = await this.account.request('GET', `/api/sync/file${this.q(p)}`, { timeoutMs: 60_000 });
    if (res.status === 404) return null;
    await this.check(res);
    const entry = JSON.parse(decodeURIComponent(res.headers.get('X-Margin-Entry') ?? '')) as RemoteEntry;
    return { bytes: new Uint8Array(await res.arrayBuffer()), entry };
  }

  async put(p: string, bytes: Uint8Array, ifMatch: string | null): Promise<RemoteEntry> {
    const res = await this.account.request('PUT', `/api/sync/file${this.q(p)}`, {
      body: bytes,
      headers: ifMatch === null ? { 'If-None-Match': '*' } : { 'If-Match': `"${ifMatch}"` },
      timeoutMs: 60_000,
    });
    return ((await (await this.check(res)).json()) as { entry: RemoteEntry }).entry;
  }

  async delete(p: string, ifMatch: string): Promise<void> {
    await this.check(await this.account.request('DELETE', `/api/sync/file${this.q(p)}`, { headers: { 'If-Match': `"${ifMatch}"` } }));
  }

  async move(from: string, to: string, ifMatch: string): Promise<RemoteEntry> {
    const res = await this.account.request('POST', '/api/sync/move', { json: { from, to, ifMatch } });
    return ((await (await this.check(res)).json()) as { entry: RemoteEntry }).entry;
  }
}

/** The library folder as a `SyncLocal`. Paths are NFC; on-disk names may differ in normalisation. */
class LibraryLocal implements SyncLocal {
  /** NFC path → on-disk path, from the last listing. */
  private disk = new Map<string, string>();

  constructor(
    private readonly library: FileSystemLibrary,
    private readonly state: StateFile,
    private readonly trash: (absolute: string) => Promise<void>,
  ) {}

  private onDisk(p: string) {
    return this.disk.get(p) ?? p;
  }

  async list(): Promise<LocalFile[]> {
    const { entries } = await this.library.listTree();
    const out: LocalFile[] = [];
    const hashes: StateFile['hashes'] = {};
    this.disk.clear();
    for (const e of entries) {
      if (e.kind !== 'document') continue;
      const nfc = e.path.normalize('NFC');
      if (!isSyncablePath(nfc) || this.disk.has(nfc)) continue;
      const size = e.size ?? -1;
      const cached = this.state.hashes[nfc];
      let hash = cached && cached.size === size && cached.mtimeMs === e.modifiedAt ? cached.hash : undefined;
      if (!hash) {
        const read = await this.library.readForSync(e.path);
        if (!read) continue;
        hash = read.hash;
      }
      hashes[nfc] = { size, mtimeMs: e.modifiedAt, hash };
      this.disk.set(nfc, e.path);
      out.push({ path: nfc, hash, size });
    }
    this.state.hashes = hashes;
    return out;
  }

  async read(p: string) {
    const r = await this.library.readForSync(this.onDisk(p));
    return r ? { bytes: new Uint8Array(r.bytes), hash: r.hash } : null;
  }

  async write(p: string, bytes: Uint8Array, expect: string | null) {
    const ok = await this.library.writeForSync(this.onDisk(p), bytes, expect);
    // Refused: our cached hash may be stale (same size and mtime); re-read next time.
    if (!ok) delete this.state.hashes[p];
    return ok;
  }

  async remove(p: string, expect: string) {
    const abs = await this.library.resolve(this.onDisk(p));
    return this.library.removeForSync(this.onDisk(p), expect, () => this.trash(abs));
  }

  move(from: string, to: string, expect: string) {
    return this.library.moveForSync(this.onDisk(from), to, expect);
  }

  async createConflictCopy(p: string, bytes: Uint8Array) {
    return (await this.library.conflictCopyForSync(this.onDisk(p), bytes)).normalize('NFC');
  }
}

export class SyncService {
  private statusValue: SyncStatus = { state: 'off' };
  private running: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Last report (tests and diagnostics). */
  lastReport: SyncReport | null = null;

  constructor(private readonly options: SyncServiceOptions) {}

  status(): SyncStatus {
    return this.statusValue;
  }

  private setStatus(s: SyncStatus): void {
    this.statusValue = s;
    this.options.onStatus?.(s);
  }

  /** Starts the timer and runs once if signed in. */
  start(): void {
    this.stopped = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.syncNow(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
    this.accountChanged();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }

  /** Called when the account status changes (sign in / out / revoked). */
  accountChanged(): void {
    if (this.options.account.status().state === 'signed-in') void this.syncNow();
    else if (!this.running) this.setStatus({ state: 'off' });
  }

  /** A local change happened (library watcher): sync soon, debounced. */
  nudge(): void {
    if (this.stopped || this.options.account.status().state !== 'signed-in') return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), this.options.debounceMs ?? 3_000);
    this.debounce.unref?.();
  }

  /** Runs now (or right after the current run). Resolves when that run is done. */
  async syncNow(): Promise<SyncStatus> {
    if (this.stopped) return this.statusValue;
    if (this.running) {
      this.again = true;
      await this.running;
      if (this.running) await this.running;
      return this.statusValue;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return this.statusValue;
  }

  private stateFile(serverUrl: string, login: string, root: string): string {
    const id = createHash('sha256').update(`${serverUrl}\n${login}\n${root}`).digest('hex').slice(0, 24);
    return path.join(this.options.stateDir, `${id}.json`);
  }

  private async loadState(file: string, serverUrl: string, login: string, root: string): Promise<StateFile> {
    try {
      const s = JSON.parse(await fs.readFile(file, 'utf8')) as StateFile;
      if (s.v === 1 && s.serverUrl === serverUrl && s.login === login && s.root === root) return s;
    } catch {
      /* missing or unreadable: start from an empty base (safe: nothing is deleted without a base) */
    }
    return { v: 1, serverUrl, login, root, base: {}, hashes: {} };
  }

  private async saveState(file: string, state: StateFile): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  private async runOnce(): Promise<void> {
    const account = this.options.account.status();
    if (account.state !== 'signed-in') return this.setStatus({ state: 'off' });
    const previous = this.statusValue;
    this.setStatus({ ...previous, state: 'syncing' });
    if (this.options.beforeSync && !(await this.options.beforeSync())) {
      return this.setStatus({ ...previous, state: previous.state === 'syncing' ? 'idle' : previous.state });
    }
    const library = this.options.library();
    const file = this.stateFile(account.serverUrl, account.login, library.root);
    const state = await this.loadState(file, account.serverUrl, account.login, library.root);
    const base = new Map(Object.entries(state.base));
    const persist = async () => {
      state.base = Object.fromEntries(base);
      await this.saveState(file, state);
    };
    try {
      const report = await runSync({
        local: new LibraryLocal(library, state, this.options.trash),
        remote: new HttpRemote(this.options.account),
        base,
        saveBase: persist,
        hash: sha256,
      });
      await persist();
      this.lastReport = report;
      const notes: string[] = [];
      if (report.rejected.length) notes.push(`${report.rejected.length} document(s) not synced (${report.rejected[0]!.reason})`);
      if (report.conflicts.length) notes.push(`${report.conflicts.length} conflict copy(s) created`);
      if (!report.settled && report.deferred.length) notes.push(`${report.deferred.length} item(s) waiting (e.g. a name that differs only in case)`);
      this.setStatus({ state: 'idle', lastSyncedAt: new Date().toISOString(), ...(notes.length ? { message: notes.join('; ') } : {}) });
    } catch (error) {
      await persist().catch(() => undefined);
      if (error instanceof AccountError) {
        this.setStatus(this.options.account.status().state === 'signed-in' ? { state: 'error', message: error.message } : { state: 'off' });
      } else if (error instanceof TypeError || (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        this.setStatus({ ...previous, state: 'offline', message: 'Can’t reach the server' });
      } else {
        console.error('Margin: sync failed', (error as Error).message);
        this.setStatus({ ...previous, state: 'error', message: 'Sync failed; will retry' });
      }
    }
  }
}
