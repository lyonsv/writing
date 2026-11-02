import { PreconditionFailedError, type KeyValueStore } from './store.js';

/**
 * Server-side single-use nonces (`auth/states/<hash>.json`) for the OAuth
 * `state`. The sealed cookie alone made state single-use only in the browser
 * that deleted it: a captured cookie could be replayed until it expired. The
 * callback now also *burns* the nonce, with the same conditional-write pattern
 * as one-time codes (ADR 0012): mark used with `ifMatch` on the ETag read, so
 * exactly one of several racing callbacks wins.
 */
export class NonceRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly prefix: string,
    /** Keyed hash (HMAC under AUTH_SECRET) for nonce storage keys. */
    private readonly hash: (value: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  private key(value: string) {
    return `${this.prefix}${this.hash(value)}.json`;
  }

  async issue(value: string, ttlMs: number): Promise<void> {
    await this.store.put(this.key(value), JSON.stringify({ v: 1, expiresAt: this.now() + ttlMs }), { create: true });
  }

  /** True exactly once per issued, unexpired nonce. */
  async burn(value: string): Promise<boolean> {
    const k = this.key(value);
    const item = await this.store.get(k);
    if (!item) return false;
    let record: { expiresAt: number; usedAt?: number };
    try {
      record = JSON.parse(item.value) as typeof record;
    } catch {
      return false;
    }
    if (record.usedAt !== undefined) return false;
    const t = this.now();
    try {
      await this.store.put(k, JSON.stringify({ ...record, usedAt: t }), { ifMatch: item.etag });
    } catch (error) {
      if (error instanceof PreconditionFailedError) return false;
      throw error;
    }
    return record.expiresAt > t;
  }

  /** Deletes nonces that expired more than a minute ago. */
  async sweep(): Promise<void> {
    const t = this.now();
    for (const k of await this.store.list(this.prefix)) {
      const item = await this.store.get(k);
      if (!item) continue;
      try {
        if ((JSON.parse(item.value) as { expiresAt: number }).expiresAt + 60_000 < t) await this.store.delete(k);
      } catch {
        await this.store.delete(k);
      }
    }
  }
}
