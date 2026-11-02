import { PreconditionFailedError, type KeyValueStore } from './store.js';

/**
 * Single-use enforcement for short-lived sign-in values (OAuth state, the
 * confirm page's CSRF token, one-time codes), in **one small record**
 * (`auth/used.json`) instead of a file per value (ADR 0021). The values
 * themselves are stateless (sealed cookies / sealed codes carry their own
 * expiry), so a sign-in step costs one write here, not create-plus-burn-plus-
 * delete. That matters on the GitHub store, where every write is a commit.
 *
 * `use(id, expiresAt)` adds the keyed hash of `id` with compare-and-swap, prunes
 * expired entries in the same write, and returns true exactly once per id, even
 * under concurrent use.
 */
export class UsedSet {
  constructor(
    private readonly store: KeyValueStore,
    /** Keyed hash (HMAC under AUTH_SECRET): raw values are never stored. */
    private readonly hash: (value: string) => string,
    private readonly now: () => number = Date.now,
    private readonly key = 'auth/used.json',
  ) {}

  async use(id: string, expiresAt: number): Promise<boolean> {
    const h = this.hash(id);
    for (let attempt = 0; attempt < 30; attempt++) {
      const item = await this.store.get(this.key);
      let used: Record<string, number> = {};
      if (item) {
        try {
          used = (JSON.parse(item.value) as { used?: Record<string, number> }).used ?? {};
        } catch {
          used = {};
        }
      }
      const t = this.now();
      if (used[h] !== undefined && used[h] > t) return false;
      for (const [k, exp] of Object.entries(used)) if (exp <= t) delete used[k];
      // Keep the marker until the value itself expires (plus a minute of clock slack).
      used[h] = Math.max(expiresAt, t) + 60_000;
      try {
        await this.store.put(this.key, JSON.stringify({ v: 1, used }), item ? { ifMatch: item.etag } : { create: true });
        return true;
      } catch (error) {
        if (!(error instanceof PreconditionFailedError)) throw error;
        await new Promise((r) => setTimeout(r, Math.random() * 25 * (attempt + 1)));
      }
    }
    throw new Error('used-set is too contended');
  }
}
