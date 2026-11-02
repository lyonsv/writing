import { describe, expect, it } from 'vitest';

import { HttpSyncRemote, SyncBackoff, SyncBusyError, retryAfterMs } from '../src';

describe('Retry-After and backoff (validator MINOR: rate limits)', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(new Date(10_000 + 5_000).toUTCString(), 10_000)).toBeLessThanOrEqual(5_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
  });

  it('backs off exponentially, never sooner than Retry-After, and resets on success', () => {
    let t = 0;
    const b = new SyncBackoff(() => t, () => 0.5); // no jitter
    expect(b.waitMs()).toBe(0);
    expect(b.fail()).toBe(30_000);
    expect(b.fail()).toBe(60_000);
    expect(b.fail(300_000)).toBe(300_000); // the server asked for longer
    expect(b.fail(1_000)).toBe(240_000); // exponential still applies on repeats
    for (let i = 0; i < 20; i++) b.fail();
    expect(b.waitMs()).toBe(30 * 60_000); // capped
    t += 10 * 60_000;
    expect(b.waitMs()).toBe(20 * 60_000);
    b.succeed();
    expect(b.waitMs()).toBe(0);
    expect(b.fail()).toBe(30_000);
  });

  it('HttpSyncRemote turns 503/429 into SyncBusyError with the server delay', async () => {
    const res = (status: number, retry?: string) => ({
      status,
      ok: false,
      headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retry ?? null : null) },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    for (const [status, retry, ms] of [[503, '42', 42_000], [429, undefined, undefined]] as const) {
      const remote = new HttpSyncRemote(async () => res(status, retry));
      const err = await remote.manifest().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SyncBusyError);
      expect((err as SyncBusyError).retryAfterMs).toBe(ms);
      expect(await remote.get('a.md').catch((e: unknown) => e)).toBeInstanceOf(SyncBusyError);
    }
  });
});
