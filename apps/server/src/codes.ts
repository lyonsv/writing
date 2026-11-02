import { pkceChallenge, randomToken, safeEqual, type Sealer } from './crypto.js';
import type { Identity } from './devices.js';
import type { UsedSet } from './usedSet.js';

/**
 * One-time authorization codes for the native flow (ADR 0011; storage ADR 0021).
 *
 * The server hands the app a code on its redirect; the app trades it, plus the
 * PKCE verifier only it holds, for a device token. A code is **sealed**
 * (AES-256-GCM under a key derived from AUTH_SECRET for this purpose only), so
 * it carries its own identity, challenge, redirect URI, device name and expiry,
 * and nothing is stored when it is issued. Single use is enforced by the shared
 * `UsedSet` (one small record). Any redemption attempt burns the code,
 * including one with the wrong verifier, and concurrent redemptions have
 * exactly one winner.
 */
export const CODE_TTL_MS = 60_000;

interface SealedCode {
  v: 1;
  /** Random id, the single-use key. */
  id: string;
  githubId: number;
  login: string;
  challenge: string;
  redirectUri: string;
  deviceName?: string;
  exp: number;
}

export type RedeemResult = { ok: true; identity: Identity; deviceName?: string } | { ok: false };

export class CodeRepository {
  constructor(
    private readonly sealer: Sealer,
    private readonly used: UsedSet,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(identity: Identity, challenge: string, redirectUri: string, deviceName?: string): Promise<string> {
    const code: SealedCode = {
      v: 1,
      id: randomToken(16),
      githubId: identity.githubId,
      login: identity.login,
      challenge,
      redirectUri,
      ...(deviceName ? { deviceName } : {}),
      exp: this.now() + CODE_TTL_MS,
    };
    return this.sealer.seal(code);
  }

  async redeem(code: string, verifier: string, redirectUri: string): Promise<RedeemResult> {
    if (!/^[A-Za-z0-9_-]{40,2048}$/.test(code)) return { ok: false };
    const record = this.sealer.unseal(code) as SealedCode | null;
    if (!record || record.v !== 1 || typeof record.id !== 'string') return { ok: false };
    // Burn first: whatever happens next, this code is spent.
    if (!(await this.used.use(`code:${record.id}`, record.exp))) return { ok: false };
    const valid =
      record.exp > this.now() &&
      safeEqual(record.redirectUri, redirectUri) &&
      safeEqual(record.challenge, pkceChallenge(verifier));
    return valid
      ? { ok: true, identity: { githubId: record.githubId, login: record.login }, deviceName: record.deviceName }
      : { ok: false };
  }
}
