import { describe, expect, it } from 'vitest';

import { AccountError, WebAccount } from '../src/web/account';

/** Validator M8 LOW: a revoked/expired session (any 401) must not leave a usable cached app behind. */
function harness(status: number) {
  const calls: string[] = [];
  const store = new Map<string, string>([['margin.account.v1', JSON.stringify({ login: 'lyonsv', deviceId: 'd'.repeat(22) })]]);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as unknown as Storage;
  const account = new WebAccount({
    fetch: (async () => new Response(status === 401 ? '{"error":"unauthorized"}' : '{}', { status })) as typeof fetch,
    origin: 'https://margin.test',
    storage,
    navigate: (url) => calls.push(`navigate ${url}`),
    onSignedOut: async () => void calls.push('signed-out cleanup'),
  });
  return { account, calls, store };
}

describe('WebAccount: a 401 is a sign-out', () => {
  it('on /api/me: cleanup (shell cache), then the sign-in page; identity forgotten', async () => {
    const h = harness(401);
    expect(h.account.current().state).toBe('signed-in'); // last known, offline-friendly
    expect((await h.account.status()).state).toBe('signed-out');
    expect(h.calls).toEqual(['signed-out cleanup', 'navigate /']);
    expect(h.store.has('margin.account.v1')).toBe(false);
  });

  it('on a sync request: same, once, and the request fails', async () => {
    const h = harness(401);
    await expect(h.account.request('GET', '/api/sync/manifest')).rejects.toBeInstanceOf(AccountError);
    await expect(h.account.request('GET', '/api/sync/manifest')).rejects.toBeInstanceOf(AccountError);
    expect(h.calls).toEqual(['signed-out cleanup', 'navigate /']);
  });

  it('a server error is not a sign-out', async () => {
    const h = harness(503);
    await h.account.status();
    expect(h.calls).toEqual([]);
    expect(h.account.current().state).toBe('signed-in');
  });
});
