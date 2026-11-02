/**
 * Upload throttling for sync clients (ADR 0021 amendments). On the GitHub store
 * every upload is ~2 commits, and GitHub's secondary limit is ~500
 * content-creating requests per hour **for the whole server token**, so clients
 * must not upload a document on every pause in typing.
 *
 * Policy, per path:
 * - `scheduled` runs (timer, change nudges): at most one upload per 60 s while
 *   it's being edited;
 * - `flush` runs (window blur or hide, switching documents): at most one per 30 s;
 * - `explicit` runs (Sync Now, quit): always.
 *
 * A held path stays unsynced: its base is untouched, so nothing is lost. The
 * client runs again when `dueIn` says it may go. Shared by the desktop and the
 * web/iOS clients; pure, with an injectable clock.
 */
export type UploadTrigger = 'scheduled' | 'flush' | 'explicit';

export const UPLOAD_MIN_INTERVAL_MS: Readonly<Record<UploadTrigger, number>> = Object.freeze({
  scheduled: 60_000,
  flush: 30_000,
  explicit: 0,
});

/** The stronger of two triggers (for merging queued sync requests). */
export function strongerTrigger(a: UploadTrigger, b: UploadTrigger): UploadTrigger {
  const rank = { scheduled: 0, flush: 1, explicit: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

export class UploadThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly intervals: Readonly<Record<UploadTrigger, number>> = UPLOAD_MIN_INTERVAL_MS,
  ) {}

  /** May `path` be uploaded in a run started by `trigger`? */
  allows(path: string, trigger: UploadTrigger): boolean {
    const t = this.last.get(path);
    return t === undefined || this.now() - t >= this.intervals[trigger];
  }

  /** Record a successful upload of `path`. */
  uploaded(path: string): void {
    const t = this.now();
    this.last.set(path, t);
    if (this.last.size > 1000) {
      for (const [p, at] of this.last) if (t - at > this.intervals.scheduled) this.last.delete(p);
    }
  }

  /** Milliseconds until every one of `paths` may go in a `scheduled` run (0 if already). */
  dueIn(paths: readonly string[]): number {
    let wait = 0;
    for (const p of paths) {
      const t = this.last.get(p);
      if (t !== undefined) wait = Math.max(wait, t + this.intervals.scheduled - this.now());
    }
    return Math.max(0, wait);
  }
}
