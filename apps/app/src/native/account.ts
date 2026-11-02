import {
  NATIVE_CUSTOM_SCHEME_REDIRECT,
  encodeBase64,
  encodeUtf8,
  parseDevices,
  type AccountBackend,
  type AccountStatus,
  type DeviceInfo,
  type NativeTokenResponse,
  type SyncHttpRequest,
  type SyncHttpResponse,
} from '@margin/core';

/**
 * iOS sign-in (ADR 0017, building on 0010–0012):
 * RFC 8252 with the `margin://auth/callback` custom scheme, through
 * `ASWebAuthenticationSession` (`WebBrowser.openAuthSessionAsync`), which hands
 * the callback only to the app that started the session. PKCE (S256) + state,
 * the server's "Sign in a new device?" confirmation page, then the one-time
 * code is exchanged for a device token, which lives only in the Keychain
 * (`expo-secure-store`, this device only). Everything platform-specific is
 * injected so the round trip is tested in Node against the real server.
 */

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AuthSessionResult = { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' | 'locked' | string };

export interface NativeAccountDeps {
  secrets: SecretStore;
  /** `WebBrowser.openAuthSessionAsync(url, redirect)`. */
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
  randomBytes: (n: number) => Uint8Array;
  sha256: (bytes: Uint8Array) => Uint8Array;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  serverUrl: () => string;
  deviceName: () => string;
  /** Development builds may use plain http to a server on the local network. */
  allowInsecureLan?: boolean;
  redirectUri?: string;
}

interface Session {
  v: 1;
  serverUrl: string;
  token: string;
  deviceId: string;
  login: string;
}

export class AccountError extends Error {
  override name = 'AccountError';
}

const SESSION_KEY = 'margin.session.v1';
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

export const SIGN_OUT_UNCONFIRMED =
  'Signed out on this iPhone, but the server didn’t confirm it, so this device’s token may still be active. ' +
  'Revoke it in Account and Devices on another signed-in device (unused tokens expire after 90 days).';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PRIVATE_LAN = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;

/** https, or http on loopback (and, in development, on a private LAN address). Returns the origin. */
export function parseServerUrl(raw: string, allowInsecureLan = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AccountError('The server URL is not valid.');
  }
  const httpOk = url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || (allowInsecureLan && PRIVATE_LAN.test(url.hostname)));
  if ((url.protocol !== 'https:' && !httpOk) || url.username || url.password) {
    throw new AccountError('The server URL must use https.');
  }
  return url.origin;
}

const b64url = (b: Uint8Array) => encodeBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Constant-time string comparison (state check). */
function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export class NativeAccount implements AccountBackend {
  readonly available = true;
  private session: Session | null = null;
  private loaded: Promise<void> | null = null;
  private signingIn = false;
  private lastError: string | undefined;
  private listeners = new Set<(s: AccountStatus) => void>();

  constructor(private readonly deps: NativeAccountDeps) {}

  private get redirectUri(): string {
    return this.deps.redirectUri ?? NATIVE_CUSTOM_SCHEME_REDIRECT;
  }

  /** Reads the Keychain once. No network. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = await this.deps.secrets.get(SESSION_KEY);
        const s = raw ? (JSON.parse(raw) as Session) : null;
        if (s?.v === 1 && typeof s.token === 'string' && typeof s.serverUrl === 'string') this.session = s;
      } catch {
        await this.deps.secrets.delete(SESSION_KEY).catch(() => undefined);
      }
    })();
    return this.loaded;
  }

  private origin(): string {
    return parseServerUrl(this.deps.serverUrl(), this.deps.allowInsecureLan);
  }

  /** The session, but only for the configured server (a token is never sent elsewhere). */
  private active(): Session | null {
    try {
      return this.session && this.session.serverUrl === this.origin() ? this.session : null;
    } catch {
      return null;
    }
  }

  current(): AccountStatus {
    let serverUrl: string;
    try {
      serverUrl = this.origin();
    } catch {
      serverUrl = this.deps.serverUrl();
    }
    if (this.signingIn) return { state: 'signing-in', serverUrl };
    const s = this.active();
    if (s) return { state: 'signed-in', serverUrl, login: s.login, deviceId: s.deviceId };
    return { state: 'signed-out', serverUrl, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  async status(): Promise<AccountStatus> {
    await this.load();
    return this.current();
  }

  onChange(listener: (s: AccountStatus) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Call after the server URL setting changes. */
  notify(): void {
    const s = this.current();
    for (const l of this.listeners) l(s);
  }

  async signIn(): Promise<AccountStatus> {
    await this.load();
    if (this.signingIn) throw new AccountError('Sign-in is already in progress.');
    let server: string;
    try {
      server = this.origin();
    } catch (error) {
      this.lastError = (error as Error).message;
      this.notify();
      throw error;
    }
    const verifier = b64url(this.deps.randomBytes(32));
    const challenge = b64url(this.deps.sha256(encodeUtf8(verifier)));
    const state = b64url(this.deps.randomBytes(24));
    this.signingIn = true;
    this.lastError = undefined;
    this.notify();
    try {
      const start = new URL('/api/auth/native/start', server);
      start.search = new URLSearchParams({
        redirect_uri: this.redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        device_name: this.deps.deviceName(),
      }).toString();
      const result = await this.deps.openAuthSession(start.toString(), this.redirectUri);
      if (result.type !== 'success' || !('url' in result)) throw new AccountError('Sign-in was cancelled.');
      if (!result.url.startsWith(`${this.redirectUri}?`)) throw new AccountError('Sign-in returned to an unexpected address.');
      const params = new URLSearchParams(result.url.slice(this.redirectUri.length + 1));
      if (!sameString(params.get('state') ?? '', state)) throw new AccountError('Sign-in link not recognised. Try again.');
      const code = params.get('code');
      if (params.get('error') || !code) {
        throw new AccountError(
          params.get('error') === 'access_denied'
            ? 'Sign-in was cancelled, or this GitHub account isn’t allowed on this server.'
            : 'The server couldn’t complete sign-in. Try again.',
        );
      }
      const res = await this.deps.fetch(new URL('/api/auth/native/token', server).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: this.redirectUri, device_name: this.deps.deviceName() }),
        redirect: 'error',
      });
      if (!res.ok) throw new AccountError('The server refused the sign-in. Try again.');
      const body = (await res.json()) as NativeTokenResponse;
      if (typeof body.token !== 'string' || !DEVICE_ID.test(body.device?.id ?? '')) throw new AccountError('Unexpected server response.');
      const session: Session = { v: 1, serverUrl: server, token: body.token, deviceId: body.device.id, login: body.login };
      await this.deps.secrets.set(SESSION_KEY, JSON.stringify(session));
      this.session = session;
    } catch (error) {
      this.lastError = error instanceof AccountError ? error.message : 'Couldn’t reach the server.';
      throw error instanceof AccountError ? error : new AccountError(this.lastError);
    } finally {
      this.signingIn = false;
      this.notify();
    }
    return this.current();
  }

  async signOut(): Promise<AccountStatus> {
    await this.load();
    let warning: string | undefined;
    if (this.active()) {
      try {
        const res = await this.request('POST', '/api/auth/signout');
        if (res.status !== 204 && res.status !== 200) warning = SIGN_OUT_UNCONFIRMED;
      } catch (error) {
        if (!(error instanceof AccountError && this.session === null)) warning = SIGN_OUT_UNCONFIRMED;
      }
    }
    await this.clear();
    this.lastError = warning;
    this.notify();
    return this.current();
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const res = await this.request('GET', '/api/devices');
    if (!res.ok) throw new AccountError('Couldn’t load devices.');
    return parseDevices(((await res.json()) as { devices?: unknown }).devices);
  }

  async revokeDevice(id: string): Promise<AccountStatus> {
    if (!DEVICE_ID.test(id)) throw new AccountError('Unknown device.');
    const self = this.active()?.deviceId === id;
    const res = await this.request('DELETE', `/api/devices/${id}`);
    if (res.status !== 204 && res.status !== 404) throw new AccountError('Couldn’t revoke the device.');
    if (self) {
      await this.clear();
      this.notify();
    }
    return this.current();
  }

  /** Authenticated request to the configured server; 401 forgets the token. Used by sync. */
  request: SyncHttpRequest = async (method, pathname, init = {}) => {
    await this.load();
    const s = this.active();
    if (!s) throw new AccountError('Not signed in.');
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${s.token}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = init.body as unknown as BodyInit;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.deps.fetch(new URL(pathname, s.serverUrl).toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'error', // never follow a redirect with the token attached
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      await this.clear();
      this.lastError = 'This device was signed out (revoked or expired).';
      this.notify();
      throw new AccountError(this.lastError);
    }
    return res as SyncHttpResponse & Response;
  };

  private async clear(): Promise<void> {
    this.session = null;
    await this.deps.secrets.delete(SESSION_KEY);
  }
}
