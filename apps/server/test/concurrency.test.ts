import { describe, expect, it } from 'vitest';

import { CodeRepository } from '../src/codes';
import { DeviceRepository, TOUCH_INTERVAL_MS } from '../src/devices';
import { Pepper, Sealer } from '../src/crypto';
import { UsedSet } from '../src/usedSet';
import { MemoryStore, type PutOptions } from '../src/store';

const pepper = new Pepper('p'.repeat(32));
import { newVerifier, s256 } from './helpers';

/** A MemoryStore that runs `hook` just before the next matching put — to force an exact interleaving. */
class InterleavingStore extends MemoryStore {
  hook?: { when: (key: string, value: string) => boolean; run: () => Promise<void> };

  override async put(key: string, value: string, options?: PutOptions) {
    const h = this.hook;
    if (h?.when(key, value)) {
      this.hook = undefined;
      await h.run();
    }
    return super.put(key, value, options);
  }
}

const who = { githubId: 1, login: 'lyonsv' };

describe('store interleavings', () => {
  it('a revoke landing between a touch’s read and write wins (no resurrection)', async () => {
    let t = 1_000_000;
    const store = new InterleavingStore();
    const repo = new DeviceRepository(store, pepper, () => t);
    const { token, record } = await repo.create(who, 'Mac', 'native');
    t += TOUCH_INTERVAL_MS + 1;
    store.hook = {
      when: (_k, v) => !v.includes('revokedAt'), // the touch's write
      run: async () => {
        expect(await repo.revoke(who, record.id)).toBe(true);
      },
    };
    expect(await repo.authenticate(token)).toBeNull();
    expect(await repo.authenticate(token)).toBeNull();
    expect(await repo.list(who)).toEqual([]);
  });

  it('a touch landing between a revoke’s read and write does not block the revoke', async () => {
    let t = 1_000_000;
    const store = new InterleavingStore();
    const repo = new DeviceRepository(store, pepper, () => t);
    const { token, record } = await repo.create(who, 'Mac', 'native');
    t += TOUCH_INTERVAL_MS + 1;
    store.hook = {
      when: (_k, v) => v.includes('revokedAt'), // the revoke's write
      run: async () => {
        expect(await repo.authenticate(token)).not.toBeNull(); // touches
      },
    };
    expect(await repo.revoke(who, record.id)).toBe(true);
    expect(await repo.authenticate(token)).toBeNull();
  });

  it('a second redemption between the first’s read and write loses', async () => {
    const store = new InterleavingStore();
    const codes = new CodeRepository(new Sealer('s'.repeat(32), 'one-time-code v1'), new UsedSet(store, pepper.hash));
    const v = newVerifier();
    const code = await codes.issue(who, s256(v), 'http://127.0.0.1:5000/callback');
    let inner: unknown;
    store.hook = {
      when: (k) => k === 'auth/used.json', // the first redemption's single-use write
      run: async () => {
        inner = await codes.redeem(code, v, 'http://127.0.0.1:5000/callback');
      },
    };
    const outer = await codes.redeem(code, v, 'http://127.0.0.1:5000/callback');
    expect(inner).toEqual({ ok: true, identity: who, deviceName: undefined });
    expect(outer).toEqual({ ok: false });
  });
});
