import { MAX_FILENAME_BYTES, isHiddenPath, isMarkdownPath, normalizeDocPath, utf8Length } from './paths';

/**
 * Sync engine (ADR 0013). Pure and platform-agnostic: the desktop (and iOS in
 * M6) supply adapters for local files, the remote API and the stored base.
 *
 * Model: three-way comparison per path between
 *   - local:  what's on this device now (path → content hash),
 *   - base:   what this device and the server last agreed on (path → hash + server rev),
 *   - remote: the server manifest (path → rev, hash; deleted = tombstone/absent).
 *
 * Safety rules (the executor re-checks each one at the moment it acts):
 *   - local content is only overwritten if it still has the hash we planned with
 *     (the base hash, or "absent" for a new file);
 *   - local content is only deleted if it still equals the base, i.e. it was
 *     synced and then deleted remotely;
 *   - when both sides changed, both are kept: the remote version takes the
 *     path and the local version is written to `name (conflict …).md` first;
 *   - remote writes are compare-and-swap on the server rev (If-Match /
 *     If-None-Match), so a concurrent change on another device is never overwritten;
 *   - an edit beats a delete, on either side.
 */

/** Lowercase hex SHA-256 of the file's bytes, on every platform and on the server. */
export type ContentHash = string;

export interface LocalFile {
  path: string;
  hash: ContentHash;
  size: number;
}

export interface BaseEntry {
  hash: ContentHash;
  rev: string;
}

export interface RemoteEntry {
  path: string;
  rev: string;
  hash: ContentHash;
  size: number;
  updatedAt: string;
  deleted?: boolean;
}

export type SyncAction =
  | { type: 'upload'; path: string; ifMatch: string | null }
  | { type: 'download'; path: string; expectLocal: ContentHash | null }
  | { type: 'delete-local'; path: string; expectLocal: ContentHash }
  | { type: 'delete-remote'; path: string; ifMatch: string }
  | { type: 'conflict'; path: string }
  | { type: 'adopt'; path: string; entry: BaseEntry }
  | { type: 'forget'; path: string }
  | { type: 'move-remote'; from: string; to: string; ifMatch: string }
  | { type: 'move-local'; from: string; to: string; expectLocal: ContentHash };

/** Largest document we sync (Vercel's request/response limit is 4.5 MB; ADR 0013). */
export const MAX_SYNC_BYTES = 4 * 1024 * 1024;
/** Longest path we sync, in UTF-8 bytes. */
export const MAX_SYNC_PATH_BYTES = 1024;

/**
 * Whether `path` can be synced: the canonical form of a library path
 * (`normalizeDocPath`), a `.md` file, no hidden segments, every name ≤ 255
 * UTF-8 bytes, the whole path ≤ 1024 bytes, and Unicode NFC (so the same name
 * typed on macOS and iOS is the same path). The server enforces the same rules
 * (apps/server/src/syncPaths.ts; a test checks they agree).
 */
export function isSyncablePath(path: string): boolean {
  if (typeof path !== 'string' || path === '' || path.normalize('NFC') !== path) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  let normalized: string;
  try {
    normalized = normalizeDocPath(path);
  } catch {
    return false;
  }
  if (normalized !== path || !isMarkdownPath(path) || isHiddenPath(path)) return false;
  if (utf8Length(path) > MAX_SYNC_PATH_BYTES) return false;
  return path.split('/').every((s) => utf8Length(s) <= MAX_FILENAME_BYTES);
}

export interface PlanOptions {
  /** Detect renames (delete + create of the same content) and turn them into moves. Default true. */
  detectMoves?: boolean;
}

/**
 * Plans what to do for every path. Pure: same inputs, same plan.
 * `remote` entries with `deleted` are treated as absent (tombstones).
 */
export function planSync(
  local: readonly LocalFile[],
  base: ReadonlyMap<string, BaseEntry>,
  remote: readonly RemoteEntry[],
  options: PlanOptions = {},
): SyncAction[] {
  const L = new Map(local.map((f) => [f.path, f]));
  const R = new Map(remote.filter((e) => !e.deleted).map((e) => [e.path, e]));
  const paths = new Set([...L.keys(), ...base.keys(), ...R.keys()]);
  const actions: SyncAction[] = [];

  for (const path of [...paths].sort()) {
    const l = L.get(path);
    const b = base.get(path);
    const r = R.get(path);

    if (!b) {
      if (l && r) actions.push(l.hash === r.hash ? { type: 'adopt', path, entry: { hash: r.hash, rev: r.rev } } : { type: 'conflict', path });
      else if (l) actions.push({ type: 'upload', path, ifMatch: null });
      else if (r) actions.push({ type: 'download', path, expectLocal: null });
      continue;
    }

    const localChanged = !l || l.hash !== b.hash;
    const remoteChanged = !r || r.rev !== b.rev;
    if (!localChanged && !remoteChanged) continue;

    if (!localChanged) {
      // Only the server moved on.
      actions.push(r ? { type: 'download', path, expectLocal: b.hash } : { type: 'delete-local', path, expectLocal: b.hash });
      continue;
    }
    if (!remoteChanged) {
      // Only we moved on.
      actions.push(l ? { type: 'upload', path, ifMatch: b.rev } : { type: 'delete-remote', path, ifMatch: b.rev });
      continue;
    }
    // Both changed.
    if (l && r) {
      actions.push(l.hash === r.hash ? { type: 'adopt', path, entry: { hash: r.hash, rev: r.rev } } : { type: 'conflict', path });
    } else if (l) {
      actions.push({ type: 'upload', path, ifMatch: null }); // edited here, deleted there: the edit wins
    } else if (r) {
      actions.push({ type: 'download', path, expectLocal: null }); // deleted here, edited there: the edit wins
    } else {
      actions.push({ type: 'forget', path }); // deleted on both sides
    }
  }

  return options.detectMoves === false ? actions : detectMoves(actions, L, base, R);
}

/**
 * A rename shows up as "delete A" + "create B" with B's content equal to A's
 * base content. Pair them (one-to-one, same hash) into a single move, which
 * is atomic on the server and keeps the file's identity locally.
 */
function detectMoves(
  actions: SyncAction[],
  L: Map<string, LocalFile>,
  base: ReadonlyMap<string, BaseEntry>,
  R: Map<string, RemoteEntry>,
): SyncAction[] {
  const out = [...actions];
  const take = (pred: (a: SyncAction) => boolean) => {
    const i = out.findIndex(pred);
    return i === -1 ? undefined : out.splice(i, 1)[0];
  };
  // Local rename: delete-remote(A) + upload-new(B), local B hash == base A hash.
  for (const del of actions.filter((a): a is Extract<SyncAction, { type: 'delete-remote' }> => a.type === 'delete-remote')) {
    const h = base.get(del.path)!.hash;
    const up = out.find((a) => a.type === 'upload' && a.ifMatch === null && !base.has(a.path) && L.get(a.path)?.hash === h);
    if (!up || up.type !== 'upload' || !out.includes(del)) continue;
    take((a) => a === del);
    take((a) => a === up);
    out.push({ type: 'move-remote', from: del.path, to: up.path, ifMatch: del.ifMatch });
  }
  // Remote rename: delete-local(A) + download-new(B), remote B hash == base A hash.
  for (const del of actions.filter((a): a is Extract<SyncAction, { type: 'delete-local' }> => a.type === 'delete-local')) {
    const h = del.expectLocal;
    const down = out.find((a) => a.type === 'download' && a.expectLocal === null && !base.has(a.path) && !L.has(a.path) && R.get(a.path)?.hash === h);
    if (!down || down.type !== 'download' || !out.includes(del)) continue;
    take((a) => a === del);
    take((a) => a === down);
    out.push({ type: 'move-local', from: del.path, to: down.path, expectLocal: h });
  }
  return out;
}

// ---------------------------------------------------------------- execution

/** Local side, e.g. the desktop library folder. Every mutation re-checks its precondition atomically. */
export interface SyncLocal {
  /** Syncable files only (see `isSyncablePath`), keyed by NFC path. */
  list(): Promise<LocalFile[]>;
  read(path: string): Promise<{ bytes: Uint8Array; hash: ContentHash } | null>;
  /** Writes only if the file's current hash is `expect` (null: only if absent). Returns false otherwise. */
  write(path: string, bytes: Uint8Array, expect: ContentHash | null): Promise<boolean>;
  /** Deletes (desktop: to the Trash) only if the current hash is `expect`. */
  remove(path: string, expect: ContentHash): Promise<boolean>;
  /** Renames only if `from` still has hash `expect` and `to` doesn't exist. */
  move(from: string, to: string, expect: ContentHash): Promise<boolean>;
  /** Creates a new file with `bytes` at `path`'s conflict-copy name (exclusive). Returns its path. */
  createConflictCopy(path: string, bytes: Uint8Array): Promise<string>;
}

/** Thrown by `SyncRemote` when an If-Match / If-None-Match precondition fails (HTTP 412) or a path is taken (409). */
export class SyncPreconditionError extends Error {
  constructor(message = 'precondition failed') {
    super(message);
    this.name = 'SyncPreconditionError';
  }
}

/** Thrown by `SyncRemote` for a document the server won't take (too large, bad path: 413/400). Skipped, not retried. */
export class SyncRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRejectedError';
  }
}

export interface SyncRemote {
  manifest(): Promise<RemoteEntry[]>;
  get(path: string): Promise<{ bytes: Uint8Array; entry: RemoteEntry } | null>;
  /** `ifMatch: null` = create-only (If-None-Match: *). */
  put(path: string, bytes: Uint8Array, ifMatch: string | null): Promise<RemoteEntry>;
  delete(path: string, ifMatch: string): Promise<void>;
  move(from: string, to: string, ifMatch: string): Promise<RemoteEntry>;
}

export interface SyncDeps {
  local: SyncLocal;
  remote: SyncRemote;
  /** The stored base; mutated in place and persisted by the caller (and via `saveBase` during the run). */
  base: Map<string, BaseEntry>;
  /** Called after each change to the base so progress survives a crash mid-run. */
  saveBase?: (base: Map<string, BaseEntry>) => Promise<void>;
  hash: (bytes: Uint8Array) => ContentHash;
  /** Passes per run: actions can create follow-up work (conflict copies, lost races). Default 4. */
  maxPasses?: number;
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  moved: string[];
  conflicts: string[];
  /** Paths left for the next run (raced with an edit or another device). */
  deferred: string[];
  /** Paths the server refused (too large, invalid), with the reason. */
  rejected: Array<{ path: string; reason: string }>;
  /** True if the last pass planned nothing: local, base and remote agree. */
  settled: boolean;
}

/**
 * Plans and executes until nothing is left to do (or `maxPasses`). Network
 * errors propagate (the caller reports "offline"); precondition failures and
 * local races just defer that path to the next pass/run.
 */
export async function runSync(deps: SyncDeps): Promise<SyncReport> {
  const report: SyncReport = {
    uploaded: [],
    downloaded: [],
    deletedLocal: [],
    deletedRemote: [],
    moved: [],
    conflicts: [],
    deferred: [],
    rejected: [],
    settled: false,
  };
  const { local, remote, base } = deps;
  const rejected = new Set<string>();
  let detectMoves = true;
  const save = async () => deps.saveBase?.(base);
  const record = async (path: string, entry: BaseEntry | null) => {
    if (entry) base.set(path, entry);
    else base.delete(path);
    await save();
  };

  for (let pass = 0; pass < (deps.maxPasses ?? 4); pass++) {
    const [files, manifest] = await Promise.all([local.list(), remote.manifest()]);
    const actions = planSync(
      files.filter((f) => !rejected.has(f.path)),
      base,
      manifest.filter((e) => !rejected.has(e.path)),
      { detectMoves },
    );
    if (actions.length === 0) {
      report.settled = true;
      break;
    }
    report.deferred = [];
    const R = new Map(manifest.map((e) => [e.path, e]));
    // Moves first (they consume paths), then everything else in path order.
    actions.sort((a, b) => Number(b.type.startsWith('move')) - Number(a.type.startsWith('move')));

    for (const action of actions) {
      const label = 'path' in action ? action.path : action.from;
      try {
        await execute(action);
      } catch (error) {
        if (error instanceof SyncPreconditionError) {
          report.deferred.push(label);
          if (action.type === 'move-remote' || action.type === 'move-local') detectMoves = false;
        } else if (error instanceof SyncRejectedError) {
          rejected.add(label);
          report.rejected.push({ path: label, reason: error.message });
        } else {
          throw error;
        }
      }
    }

    async function execute(action: SyncAction): Promise<void> {
      switch (action.type) {
        case 'adopt':
          return record(action.path, action.entry);
        case 'forget':
          return record(action.path, null);
        case 'upload': {
          const file = await local.read(action.path);
          if (!file) throw new SyncPreconditionError('vanished locally');
          const entry = await remote.put(action.path, file.bytes, action.ifMatch);
          report.uploaded.push(action.path);
          return record(action.path, { hash: entry.hash, rev: entry.rev });
        }
        case 'download': {
          const got = await remote.get(action.path);
          if (!got) throw new SyncPreconditionError('vanished remotely');
          if (deps.hash(got.bytes) !== got.entry.hash) throw new Error(`Downloaded ${action.path} does not match its hash`);
          if (!(await local.write(action.path, got.bytes, action.expectLocal))) throw new SyncPreconditionError('changed locally');
          report.downloaded.push(action.path);
          return record(action.path, { hash: got.entry.hash, rev: got.entry.rev });
        }
        case 'delete-local': {
          if (!(await local.remove(action.path, action.expectLocal))) throw new SyncPreconditionError('changed locally');
          report.deletedLocal.push(action.path);
          return record(action.path, null);
        }
        case 'delete-remote': {
          await remote.delete(action.path, action.ifMatch);
          report.deletedRemote.push(action.path);
          return record(action.path, null);
        }
        case 'move-remote': {
          const entry = await remote.move(action.from, action.to, action.ifMatch);
          report.moved.push(`${action.from} → ${action.to}`);
          await record(action.from, null);
          return record(action.to, { hash: entry.hash, rev: entry.rev });
        }
        case 'move-local': {
          const target = R.get(action.to)!;
          if (!(await local.move(action.from, action.to, action.expectLocal))) throw new SyncPreconditionError('changed locally');
          report.moved.push(`${action.from} → ${action.to}`);
          await record(action.from, null);
          return record(action.to, { hash: target.hash, rev: target.rev });
        }
        case 'conflict': {
          const got = await remote.get(action.path);
          const mine = await local.read(action.path);
          if (!got || !mine) throw new SyncPreconditionError('vanished');
          if (deps.hash(got.bytes) !== got.entry.hash) throw new Error(`Downloaded ${action.path} does not match its hash`);
          if (mine.hash === got.entry.hash) return record(action.path, { hash: got.entry.hash, rev: got.entry.rev });
          // Keep ours first, then let theirs take the path (only if ours is still what we copied).
          await local.createConflictCopy(action.path, mine.bytes);
          if (!(await local.write(action.path, got.bytes, mine.hash))) throw new SyncPreconditionError('changed locally');
          report.conflicts.push(action.path);
          return record(action.path, { hash: got.entry.hash, rev: got.entry.rev });
        }
      }
    }
  }
  return report;
}

/** What the desktop shows about sync (renderer-safe; no paths of other devices, no tokens). */
export interface SyncStatus {
  /** off: signed out. idle: last run finished cleanly. */
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error';
  lastSyncedAt?: string;
  /** Short human text for errors and skipped documents. */
  message?: string;
}
