import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** `bytes` of CSPRNG output, base64url (no padding). 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

export function sha256Hex(input: string): string {
  return sha256(input).toString('hex');
}

/**
 * Constant-time string equality. Both sides are hashed first so inputs of
 * different lengths don't short-circuit (`timingSafeEqual` throws on unequal
 * lengths, which would itself leak the length).
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Constant-time comparison of a stored hex SHA-256 against the hash of `secret`. */
export function hashMatches(storedHex: string, secret: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const actual = sha256(secret);
  if (stored.length !== actual.length) return false;
  return timingSafeEqual(stored, actual);
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallenge(verifier: string): string {
  return sha256(verifier).toString('base64url');
}

/** RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is exactly 43 base64url chars. */
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Authenticated encryption (AES-256-GCM) for the short-lived OAuth state
 * cookie, so the browser carries the pending sign-in without being able to
 * read or forge it. The key is derived from AUTH_SECRET with HKDF.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'margin', 'oauth-state-cookie v1', 32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** Returns null for anything tampered, truncated or not ours. */
  unseal(sealed: string): unknown {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}
