import { pkceChallenge, randomToken, safeEqual, type Pepper } from './crypto.js';
import { PreconditionFailedError, type KeyValueStore } from './store.js';
import type { Identity } from './devices.js';

/**
 * One-time authorization codes for the native flow (ADR 0011).
 *
 * The server hands the app a code on its redirect; the app trades it, plus the
 * PKCE verifier only it holds, for a device token. Codes:
 * - are 256-bit random, stored only as SHA-256 (`auth/codes/<hash>.json`);
 * - expire after CODE_TTL_MS;
 * - are bound to the redirect URI and the app's S256 challenge;
 * - are single-use, even under concurrent redemption: the redeemer marks the
 *   record used with a conditional write on the ETag it read, so exactly one
 *   of several racing redeemers wins. Any redemption attempt burns the code,
 *   including one with the wrong verifier.
 */
export const CODE_TTL_MS = 60_000;
const PREFIX = 'auth/codes/';

interface CodeRecord {
  v: 1;
  githubId: number;
  login: string;
  challenge: string;
  redirectUri: string;
  /** Device name the user confirmed on the server's page; becomes the device's name. */
  deviceName?: string;
  expiresAt: number;
  usedAt?: number;
}

export type RedeemResult = { ok: true; identity: Identity; deviceName?: string } | { ok: false };

export class CodeRepository {
  constructor(
    private readonly store: KeyValueStore,
    /** Keyed hash (HMAC under AUTH_SECRET) for code storage keys. */
    private readonly pepper: Pick<Pepper, 'hash'>,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(identity: Identity, challenge: string, redirectUri: string, deviceName?: string): Promise<string> {
    const code = randomToken(32);
    const record: CodeRecord = {
      v: 1,
      githubId: identity.githubId,
      login: identity.login,
      challenge,
      redirectUri,
      ...(deviceName ? { deviceName } : {}),
      expiresAt: this.now() + CODE_TTL_MS,
    };
    await this.store.put(`${PREFIX}${this.pepper.hash(code)}.json`, JSON.stringify(record), { create: true });
    return code;
  }

  async redeem(code: string, verifier: string, redirectUri: string): Promise<RedeemResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return { ok: false };
    const k = `${PREFIX}${this.pepper.hash(code)}.json`;
    const item = await this.store.get(k);
    if (!item) return { ok: false };
    let record: CodeRecord;
    try {
      record = JSON.parse(item.value) as CodeRecord;
    } catch {
      return { ok: false };
    }
    if (record.usedAt !== undefined) return { ok: false };
    const t = this.now();
    try {
      await this.store.put(k, JSON.stringify({ ...record, usedAt: t }), { ifMatch: item.etag });
    } catch (error) {
      if (error instanceof PreconditionFailedError) return { ok: false }; // lost the race
      throw error;
    }
    // Burned. The record stays as a "used" marker until it is cleaned up after expiry.
    const valid =
      record.expiresAt > t &&
      safeEqual(record.redirectUri, redirectUri) &&
      safeEqual(record.challenge, pkceChallenge(verifier));
    return valid
      ? { ok: true, identity: { githubId: record.githubId, login: record.login }, deviceName: record.deviceName }
      : { ok: false };
  }

  /** Deletes codes that expired more than a minute ago (used or not). Cheap; called opportunistically. */
  async sweep(): Promise<void> {
    const t = this.now();
    for (const k of await this.store.list(PREFIX)) {
      const item = await this.store.get(k);
      if (!item) continue;
      try {
        const r = JSON.parse(item.value) as CodeRecord;
        if (r.expiresAt + 60_000 < t) await this.store.delete(k);
      } catch {
        await this.store.delete(k);
      }
    }
  }
}
