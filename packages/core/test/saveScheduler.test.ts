import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveScheduler, type SaveStatus } from '../src';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SaveScheduler', () => {
  it('serialises saves and coalesces to the latest text', async () => {
    const calls: string[] = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const s = new SaveScheduler((t) => {
      calls.push(t);
      const d = deferred();
      gates.push(d);
      return d.promise;
    });
    s.submit('a');
    s.submit('ab');
    s.submit('abc');
    expect(calls).toEqual(['a']);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'abc']));
    gates[1]!.resolve();
    await s.flush();
    expect(s.dirty).toBe(false);
    expect(s.currentStatus).toBe('saved');
  });

  it('reports errors and retries with backoff, keeping the latest text', async () => {
    const statuses: SaveStatus[] = [];
    let fail = true;
    const saved: string[] = [];
    const s = new SaveScheduler(
      async (t) => {
        if (fail) throw new Error('disk full');
        saved.push(t);
      },
      { backoffMs: [100, 1000], onStatus: (st) => statuses.push(st) },
    );
    s.submit('one');
    await s.flush();
    expect(s.currentStatus).toBe('error');
    expect(s.dirty).toBe(true);
    expect(s.latestText).toBe('one');
    s.submit('two'); // waits for the backoff timer rather than hammering
    await vi.advanceTimersByTimeAsync(100);
    expect(s.currentStatus).toBe('error');
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    await s.flush();
    expect(saved).toEqual(['two']);
    expect(s.currentStatus).toBe('saved');
    expect(statuses).toEqual(['saving', 'error', 'saving', 'error', 'saving', 'saved']);
  });

  it('flush retries immediately when a backoff is pending', async () => {
    let fail = true;
    const saved: string[] = [];
    const s = new SaveScheduler(async (t) => {
      if (fail) throw new Error('nope');
      saved.push(t);
    }, { backoffMs: [60_000] });
    s.submit('x');
    await s.flush();
    fail = false;
    await s.flush();
    expect(saved).toEqual(['x']);
    expect(s.dirty).toBe(false);
  });

  it('flush waits for an in-flight save', async () => {
    const d = deferred();
    const s = new SaveScheduler(() => d.promise);
    s.submit('x');
    let flushed = false;
    const f = s.flush().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);
    d.resolve();
    await f;
    expect(flushed).toBe(true);
  });
});
