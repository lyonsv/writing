/**
 * Fixed-window rate limiter, in memory, per server instance.
 *
 * Limitation (documented in ADR 0010): on Vercel each Fluid Compute instance
 * keeps its own counters and they reset on cold start, so the effective limit
 * is "per instance". That is enough to blunt scripted abuse of the auth
 * endpoints for a single-user app; tokens and codes are 256-bit, so guessing
 * isn't the threat. Use Vercel Firewall rate-limit rules if a real limit is needed.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; returns false if `key` is over the limit for the current window. */
  hit(key: string): boolean {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(t);
    }
    w.count++;
    return w.count <= this.limit;
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
