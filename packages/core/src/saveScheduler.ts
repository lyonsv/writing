// Core has no DOM/Node lib; timers exist in every JS host we target.
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SaveStatus = 'saved' | 'saving' | 'error';

export interface SaveSchedulerOptions {
  /** Retry delays in ms; the last value repeats. */
  backoffMs?: readonly number[];
  onStatus?: (status: SaveStatus, error?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Serialises saves of one document:
 * - at most one save in flight; newer text submitted meanwhile is coalesced
 *   so only the latest pending text is written next (last write wins);
 * - failed saves are retried with backoff until they succeed or newer text
 *   replaces them; status changes are reported so the UI can show "Not saved";
 * - `flush()` resolves once everything submitted so far has been attempted,
 *   retrying immediately if a backoff timer is pending.
 */
export class SaveScheduler {
  private pending: string | null = null;
  private running: Promise<void> | null = null;
  private retryTimer: unknown = undefined;
  private attempt = 0;
  private status: SaveStatus = 'saved';
  private readonly backoff: readonly number[];

  constructor(
    private readonly save: (text: string) => Promise<void>,
    private readonly options: SaveSchedulerOptions = {},
  ) {
    this.backoff = options.backoffMs?.length ? options.backoffMs : [500, 1000, 2000, 5000, 10000, 30000];
  }

  get currentStatus(): SaveStatus {
    return this.status;
  }

  /** True while text is pending, in flight, or failed. */
  get dirty(): boolean {
    return this.pending !== null || this.running !== null || this.status === 'error';
  }

  submit(text: string): void {
    this.pending = text;
    if (this.retryTimer === undefined) this.kick();
  }

  /** Attempts every pending save now. Resolves even if the save fails (status becomes 'error'). */
  async flush(): Promise<void> {
    if (this.retryTimer !== undefined) {
      this.clearRetry();
      this.kick();
    }
    while (this.running) await this.running;
  }

  dispose(): void {
    this.clearRetry();
  }

  private kick(): void {
    if (this.running || this.pending === null) return;
    this.running = this.loop().finally(() => {
      this.running = null;
      // Text submitted after the loop's last check but before this callback.
      if (this.retryTimer === undefined) this.kick();
    });
  }

  private async loop(): Promise<void> {
    while (this.pending !== null) {
      const text = this.pending;
      this.pending = null;
      this.setStatus('saving');
      try {
        await this.save(text);
        this.attempt = 0;
      } catch (error) {
        // Keep the failed text unless something newer arrived meanwhile.
        this.pending ??= text;
        this.setStatus('error', error);
        const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)]!;
        this.attempt++;
        this.retryTimer = this.timer(() => {
          this.retryTimer = undefined;
          this.kick();
        }, delay);
        return;
      }
    }
    this.setStatus('saved');
  }

  private setStatus(status: SaveStatus, error?: unknown): void {
    if (status === this.status && status !== 'error') return;
    this.status = status;
    this.options.onStatus?.(status, error);
  }

  private timer(fn: () => void, ms: number): unknown {
    return (this.options.setTimer ?? ((f, t) => timers.setTimeout(f, t)))(fn, ms);
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    (this.options.clearTimer ?? ((h) => timers.clearTimeout(h)))(this.retryTimer);
    this.retryTimer = undefined;
  }
}
