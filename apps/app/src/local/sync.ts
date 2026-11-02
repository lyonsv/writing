import {
  HttpSyncRemote,
  SyncBackoff,
  SyncBusyError,
  UploadThrottle,
  strongerTrigger,
  decodeUtf8,
  encodeUtf8,
  foldPathCase,
  isSyncablePath,
  runSync,
  type BaseEntry,
  type LocalFile,
  type SyncHttpRequest,
  type SyncLocal,
  type SyncReport,
  type SyncStatus,
  type UploadTrigger,
} from '@margin/core';

import type { NativeLibrary } from './library';
import { sha256Hex } from './library';
import type { NativeFs } from './nativeFs';

/**
 * iOS and web sync (ADR 0013 engine, ADR 0015/0020): the same core `runSync`
 * and HTTP client as desktop, over the iOS/IndexedDB library. One run at a
 * time; a request during a run queues exactly one more, with the strongest
 * trigger of the requests it merged.
 *
 * Commit budget (ADR 0021 amendments; same policy as desktop): every upload is
 * ~2 commits on the GitHub store, so uploads are throttled per path by trigger:
 * - `scheduled` (timer, the change nudge a few seconds after edits): ≤ 1 per 60 s;
 * - `flush` (page hidden / pagehide, iOS background): ≤ 1 per 30 s;
 * - `explicit` (Sync button, pull-to-refresh, Sync Now, Reset): always.
 * A held path keeps its base, so nothing is lost; a follow-up run is scheduled
 * for when it may go. A 503/429 from the server pauses syncing for the longer
 * of `Retry-After` and an exponential backoff (`SyncBackoff`).
 *
 * The throttle and backoff live in this object, i.e. **per tab** on the web
 * (and per app on iOS). Tabs share a Web Lock, so runs never overlap, but each
 * tab keeps its own upload clock: with N tabs open a path can go up to N times
 * a minute while being edited. The installed iPhone app is a single window, so
 * that's 1 there.
 */

export interface AccountLike {
  current(): { state: string; serverUrl: string; login?: string };
  request: SyncHttpRequest;
}

export interface NativeSyncOptions {
  library: NativeLibrary;
  fs: NativeFs;
  account: AccountLike;
  /** Folder for per-account state, relative to the fs base. Default `.margin/sync`. */
  stateDir?: string;
  /** Flush the editor first; false skips this run. */
  beforeSync?: () => Promise<boolean>;
  onStatus?: (s: SyncStatus) => void;
  debounceMs?: number;
  /** Name of this device in messages. */
  deviceLabel?: string;
  /** Clock for the throttle and backoff (tests). */
  now?: () => number;
  random?: () => number;
  /**
   * Web: a lock shared by all tabs of this library (Web Locks), so only one tab
   * syncs at a time and no tab saves in the middle of another's run. Taken after
   * `beforeSync` (whose flush saves under the same lock).
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface StateFile {
  v: 1;
  serverUrl: string;
  login: string;
  root: string;
  base: Record<string, BaseEntry>;
}

/** The iOS library as a `SyncLocal`. Paths are NFC; on-disk names may differ in normalisation. */
export class LibrarySyncLocal implements SyncLocal {
  private disk = new Map<string, string>();
  constructor(private readonly library: NativeLibrary) {}

  private onDisk(p: string) {
    return this.disk.get(p) ?? p;
  }

  async list(): Promise<LocalFile[]> {
    const { entries } = await this.library.listTree();
    const out: LocalFile[] = [];
    this.disk.clear();
    const folded = new Set<string>();
    for (const e of entries) {
      if (e.kind !== 'document') continue;
      const nfc = e.path.normalize('NFC');
      if (!isSyncablePath(nfc) || this.disk.has(nfc) || folded.has(foldPathCase(nfc))) continue;
      const h = await this.library.hashForSync(e.path);
      if (!h) continue;
      folded.add(foldPathCase(nfc));
      this.disk.set(nfc, e.path);
      out.push({ path: nfc, hash: h.hash, size: h.size });
    }
    return out;
  }

  /** A refused or failed action means our cached hash may be wrong: forget it. */
  private async guarded(paths: string[], fn: () => Promise<boolean>): Promise<boolean> {
    try {
      const ok = await fn();
      if (!ok) for (const p of paths) this.library.forgetHash(this.onDisk(p));
      return ok;
    } catch (error) {
      for (const p of paths) this.library.forgetHash(this.onDisk(p));
      throw error;
    }
  }

  async read(p: string) {
    return this.library.readForSync(this.onDisk(p));
  }
  write(p: string, bytes: Uint8Array, expect: string | null) {
    return this.guarded([p], () => this.library.writeForSync(this.onDisk(p), bytes, expect));
  }
  remove(p: string, expect: string) {
    return this.guarded([p], () => this.library.removeForSync(this.onDisk(p), expect));
  }
  move(from: string, to: string, expect: string) {
    return this.guarded([from, to], () => this.library.moveForSync(this.onDisk(from), to, expect));
  }
  async createConflictCopy(p: string, bytes: Uint8Array) {
    return (await this.library.conflictCopyForSync(this.onDisk(p), bytes)).normalize('NFC');
  }
}

export class NativeSyncService {
  private statusValue: SyncStatus = { state: 'off' };
  private running: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private busyTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(s: SyncStatus) => void>();
  private pendingTrigger: UploadTrigger = 'scheduled';
  private readonly throttle: UploadThrottle;
  private readonly backoff: SyncBackoff;
  lastReport: SyncReport | null = null;

  constructor(private readonly options: NativeSyncOptions) {
    this.throttle = new UploadThrottle(options.now ?? Date.now);
    this.backoff = new SyncBackoff(options.now ?? Date.now, options.random ?? Math.random);
  }

  status(): SyncStatus {
    return this.statusValue;
  }

  onChange(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private setStatus(s: SyncStatus): void {
    this.statusValue = s;
    this.options.onStatus?.(s);
    for (const l of this.listeners) l(s);
  }

  private signedIn(): boolean {
    return this.options.account.current().state === 'signed-in';
  }

  /** App came to the foreground (or sign-in changed): sync now, and poll while active. */
  resume(intervalMs = 60_000): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.syncNow('scheduled'), intervalMs);
    if (this.signedIn()) void this.syncNow('scheduled');
    else if (!this.running) this.setStatus({ state: 'off' });
  }

  /** App went to the background: stop polling (iOS suspends us anyway). */
  pause(): void {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    clearTimeout(this.heldTimer);
    clearTimeout(this.busyTimer);
    this.timer = undefined;
  }

  /** A local edit happened: sync soon, debounced. */
  nudge(): void {
    if (!this.signedIn()) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow('scheduled'), this.options.debounceMs ?? 3_000);
  }

  /**
   * Runs now (or right after the current run). `trigger` sets how strictly
   * uploads are throttled; a direct call (the Sync button, pull-to-refresh) is
   * `explicit`.
   */
  async syncNow(trigger: UploadTrigger = 'explicit'): Promise<SyncStatus> {
    this.pendingTrigger = strongerTrigger(this.pendingTrigger, trigger);
    if (this.running) {
      this.again = true;
      await this.running;
      if (this.running) await this.running;
      return this.statusValue;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const runTrigger = this.pendingTrigger;
        this.pendingTrigger = 'scheduled';
        await this.runOnce(runTrigger);
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return this.statusValue;
  }

  /** Forgets what this library last agreed with the server, then syncs (docs/sync-recovery.md). Never deletes text. */
  async resetBase(): Promise<SyncStatus> {
    const a = this.options.account.current();
    if (a.state !== 'signed-in' || !a.login) return this.statusValue;
    while (this.running) await this.running;
    await this.options.fs.remove(this.stateFile(a.serverUrl, a.login));
    return this.syncNow();
  }

  /** Quiet status while backing off: "Sync paused — retrying in N s" (not an error: nothing is wrong locally). */
  private pausedStatus(waitMs: number): SyncStatus {
    return { ...this.statusValue, state: 'offline', message: `Sync paused — retrying in ${Math.ceil(waitMs / 1000)} s` };
  }

  private stateFile(serverUrl: string, login: string): string {
    const id = sha256Hex(encodeUtf8(`${serverUrl}\n${login}\n${this.options.library.root}`)).slice(0, 24);
    return `${this.options.stateDir ?? '.margin/sync'}/${id}.json`;
  }

  private async loadState(file: string, serverUrl: string, login: string): Promise<StateFile> {
    const root = this.options.library.root;
    try {
      const s = JSON.parse(decodeUtf8(await this.options.fs.readBytes(file)) ?? '') as StateFile;
      if (s.v === 1 && s.serverUrl === serverUrl && s.login === login && s.root === root) return s;
    } catch {
      /* missing or unreadable: an empty base is safe (nothing is deleted without one) */
    }
    return { v: 1, serverUrl, login, root, base: {} };
  }

  private async runOnce(trigger: UploadTrigger = 'scheduled'): Promise<void> {
    const a = this.options.account.current();
    if (a.state !== 'signed-in' || !a.login) return this.setStatus({ state: 'off' });
    // Paused after a 503/429: don't add to the load, even for an explicit sync. A retry is scheduled.
    if (this.backoff.waitMs() > 0) return this.setStatus(this.pausedStatus(this.backoff.waitMs()));
    const previous = this.statusValue;
    this.setStatus({ ...previous, state: 'syncing' });
    if (this.options.beforeSync && !(await this.options.beforeSync())) {
      return this.setStatus({ ...previous, state: previous.state === 'syncing' ? 'idle' : previous.state });
    }
    const file = this.stateFile(a.serverUrl, a.login);
    const state = await this.loadState(file, a.serverUrl, a.login);
    const base = new Map(Object.entries(state.base));
    const persist = async () => {
      state.base = Object.fromEntries(base);
      await this.options.fs.mkdir(file.slice(0, file.lastIndexOf('/')));
      await this.options.fs.writeAtomic(file, encodeUtf8(JSON.stringify(state)));
    };
    try {
      const exclusive = this.options.exclusive ?? (<T,>(fn: () => Promise<T>) => fn());
      const report = await exclusive(() =>
        runSync({
          local: new LibrarySyncLocal(this.options.library),
          remote: new HttpSyncRemote(this.options.account.request),
          base,
          saveBase: persist,
          hash: sha256Hex,
          allowUpload: (p) => this.throttle.allows(p, trigger),
          onUploaded: (p) => this.throttle.uploaded(p),
        }),
      );
      await persist();
      this.backoff.succeed();
      this.lastReport = report;
      // Held uploads go as soon as the throttle allows (at most a minute later).
      clearTimeout(this.heldTimer);
      if (report.held.length) this.heldTimer = setTimeout(() => void this.syncNow('scheduled'), this.throttle.dueIn(report.held) + 50);
      if (report.stale.length) {
        this.setStatus({
          state: 'error',
          lastSyncedAt: previous.lastSyncedAt,
          message: `the server's copy of ${report.stale.length} document(s) is older than this ${this.options.deviceLabel ?? 'iPhone'}'s; nothing was changed`,
        });
        return;
      }
      const notes: string[] = [];
      if (report.rejected.length) notes.push(`${report.rejected.length} document(s) not synced (${report.rejected[0]!.reason})`);
      if (report.conflicts.length) notes.push(`${report.conflicts.length} conflict copy(s) created`);
      if (!report.settled && report.deferred.length) notes.push(`${report.deferred.length} item(s) couldn’t sync this time; will retry`);
      this.setStatus({ state: 'idle', lastSyncedAt: new Date().toISOString(), ...(notes.length ? { message: notes.join('; ') } : {}) });
    } catch (error) {
      await persist().catch(() => undefined);
      const name = (error as Error).name;
      if (error instanceof SyncBusyError) {
        const wait = this.backoff.fail(error.retryAfterMs);
        clearTimeout(this.busyTimer);
        this.busyTimer = setTimeout(() => void this.syncNow('scheduled'), wait + 50);
        this.setStatus(this.pausedStatus(wait));
      } else if (name === 'AccountError') {
        this.setStatus(this.signedIn() ? { state: 'error', message: (error as Error).message } : { state: 'off' });
      } else if (error instanceof TypeError || name === 'AbortError' || name === 'TimeoutError') {
        this.setStatus({ ...previous, state: 'offline', message: 'Can’t reach the server' });
      } else {
        console.error('Margin: sync failed', (error as Error).message);
        this.setStatus({ ...previous, state: 'error', message: 'Sync failed; will retry' });
      }
    }
  }
}
