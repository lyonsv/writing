import type { DeviceInfo } from '@margin/core';

import { randomToken, type Pepper } from './crypto.js';
import { PreconditionFailedError, type KeyValueStore } from './store.js';

/**
 * Device tokens (ADR 0012).
 *
 * A token is `mgn_<deviceId>.<secret>`: the id selects the record, the 256-bit
 * secret is verified against the stored SHA-256 with a constant-time compare.
 * Only an HMAC of the secret (keyed by AUTH_SECRET) is stored. Records live at `auth/devices/<id>.json`.
 *
 * Expiry is rolling: a successful use pushes `expiresAt` to now + TTL, at most
 * once per TOUCH_INTERVAL so a busy client doesn't write on every request.
 *
 * Revocation overwrites the record with a tombstone (`revokedAt`) instead of
 * deleting it. A concurrent "touch" uses `ifMatch` on the ETag it read, so it
 * fails against the tombstone and can never resurrect a revoked device. (What
 * Blob does with `ifMatch` on a deleted key is undocumented, so we never rely
 * on it.) Tombstones are pruned a week after revocation.
 */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = 'auth/devices/';
const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^mgn_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface DeviceRecord {
  v: 1;
  id: string;
  tokenHash: string;
  name: string;
  kind: 'native' | 'web';
  githubId: number;
  login: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface Identity {
  githubId: number;
  login: string;
}

export function isDeviceId(id: string): boolean {
  return ID.test(id);
}

const key = (id: string) => `${PREFIX}${id}.json`;

function parseRecord(value: string): DeviceRecord | null {
  try {
    const r = JSON.parse(value) as DeviceRecord;
    if (r?.v !== 1 || typeof r.id !== 'string' || typeof r.tokenHash !== 'string') return null;
    return r;
  } catch {
    return null;
  }
}

/** Device names come from clients: keep them short and printable. */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Unnamed device';
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return name || 'Unnamed device';
}

export function toDeviceInfo(r: DeviceRecord, currentId?: string): DeviceInfo {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: new Date(r.createdAt).toISOString(),
    lastUsedAt: new Date(r.lastUsedAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    current: r.id === currentId,
  };
}

export class DeviceRepository {
  constructor(
    private readonly store: KeyValueStore,
    /** Keyed hash (HMAC under AUTH_SECRET) for token secrets. */
    private readonly pepper: Pick<Pepper, 'hash' | 'matches'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates a device and returns its one-time-visible token. */
  async create(identity: Identity, name: string, kind: 'native' | 'web'): Promise<{ token: string; record: DeviceRecord }> {
    const id = randomToken(16);
    const secret = randomToken(32);
    const t = this.now();
    const record: DeviceRecord = {
      v: 1,
      id,
      tokenHash: this.pepper.hash(secret),
      name: cleanDeviceName(name),
      kind,
      githubId: identity.githubId,
      login: identity.login,
      createdAt: t,
      lastUsedAt: t,
      expiresAt: t + TOKEN_TTL_MS,
    };
    await this.store.put(key(id), JSON.stringify(record), { create: true });
    return { token: `mgn_${id}.${secret}`, record };
  }

  /**
   * Resolves a presented token to its live device record, or null for any
   * malformed, unknown, wrong-secret, revoked or expired token. Callers must
   * not distinguish these cases to the client.
   */
  async authenticate(token: string): Promise<DeviceRecord | null> {
    return (await this.authenticateAndTouch(token))?.record ?? null;
  }

  /** Like `authenticate`, and says whether this call rolled the expiry forward (web: re-issue the cookie). */
  async authenticateAndTouch(token: string): Promise<{ record: DeviceRecord; touched: boolean } | null> {
    const m = TOKEN.exec(token);
    if (!m) return null;
    const item = await this.store.get(key(m[1]!));
    const record = item ? parseRecord(item.value) : null;
    // Always run the comparison, so unknown ids and wrong secrets take similar time.
    const ok = this.pepper.matches(record?.tokenHash ?? '0'.repeat(64), m[2]!);
    if (!item || !record || !ok || record.id !== m[1]) return null;
    const t = this.now();
    if (record.revokedAt !== undefined || record.expiresAt <= t) return null;
    if (t - record.lastUsedAt >= TOUCH_INTERVAL_MS) {
      const touched: DeviceRecord = { ...record, lastUsedAt: t, expiresAt: t + TOKEN_TTL_MS };
      try {
        await this.store.put(key(record.id), JSON.stringify(touched), { ifMatch: item.etag });
        return { record: touched, touched: true };
      } catch (error) {
        if (!(error instanceof PreconditionFailedError)) throw error;
        // Someone else wrote first (another request's touch, or a revocation): re-read.
        const again = await this.store.get(key(record.id));
        const fresh = again ? parseRecord(again.value) : null;
        if (!fresh || fresh.revokedAt !== undefined || fresh.expiresAt <= t) return null;
        return { record: fresh, touched: true }; // another request touched it just now
      }
    }
    return { record, touched: false };
  }

  /** Live (unrevoked, unexpired) devices of this user, newest first. Prunes old tombstones. */
  async list(identity: Identity): Promise<DeviceRecord[]> {
    const t = this.now();
    const out: DeviceRecord[] = [];
    for (const k of await this.store.list(PREFIX)) {
      const item = await this.store.get(k);
      const r = item ? parseRecord(item.value) : null;
      if (!r) continue;
      const deadSince = r.revokedAt ?? r.expiresAt;
      if (deadSince <= t) {
        if (t - deadSince > TOMBSTONE_RETENTION_MS) await this.store.delete(k);
        continue;
      }
      if (r.githubId === identity.githubId) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Revokes a device of this user. Returns false if there's no such live device. */
  async revoke(identity: Identity, id: string): Promise<boolean> {
    if (!isDeviceId(id)) return false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.store.get(key(id));
      const r = item ? parseRecord(item.value) : null;
      if (!item || !r || r.githubId !== identity.githubId || r.revokedAt !== undefined) return false;
      const t = this.now();
      const tombstone: DeviceRecord = { ...r, tokenHash: '0'.repeat(64), revokedAt: t, expiresAt: Math.min(r.expiresAt, t) };
      try {
        await this.store.put(key(id), JSON.stringify(tombstone), { ifMatch: item.etag });
        return true;
      } catch (error) {
        // Raced with a touch: read again and retry, so a revoke always lands.
        if (!(error instanceof PreconditionFailedError)) throw error;
      }
    }
    throw new Error('Could not revoke device after repeated conflicts');
  }
}
