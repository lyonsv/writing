import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import { parseDevices, type AccountStatus, type DeviceInfo, type NativeTokenResponse } from '@margin/core';

/**
 * Desktop sign-in and device token handling (main process only).
 * See docs/decisions/0010-auth-model.md and 0011-native-redirect.md.
 *
 * - Sign-in is RFC 8252 with a loopback redirect: we listen on
 *   127.0.0.1:<random port>/callback, open the system browser at the server's
 *   start URL with our PKCE challenge and state, receive a one-time code, and
 *   exchange it (with the verifier only we hold) for a device token.
 * - The token is encrypted with `safeStorage` (Keychain-backed on macOS) in
 *   userData and never leaves this process: the renderer only ever gets
 *   `AccountStatus` and `DeviceInfo`.
 * - Nothing here runs at startup except reading the local file, so the app
 *   works fully offline and signed out.
 */

export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

export interface AccountOptions {
  /** Encrypted session file, e.g. userData/account/session.bin. */
  file: string;
  /** The configured server origin (validated with `parseServerUrl`). */
  serverUrl: () => string;
  /** Opens the system browser. */
  openExternal: (url: string) => Promise<void>;
  secretBox: SecretBox;
  deviceName: () => string;
  fetch?: typeof fetch;
  onChange?: (status: AccountStatus) => void;
  signInTimeoutMs?: number;
}

interface Session {
  v: 1;
  serverUrl: string;
  token: string;
  deviceId: string;
  login: string;
}

export class AccountError extends Error {}

export const SIGN_OUT_UNCONFIRMED =
  'Signed out on this Mac, but the server didn’t confirm it, so this device’s token may still be active. ' +
  'Revoke it in Account and Devices on another signed-in device (unused tokens expire after 90 days).';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

/** Server URLs must be https, or plain http on loopback (local dev). Returns the origin. */
export function parseServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccountError('The server URL is not valid.');
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok || url.username || url.password) throw new AccountError('The server URL must use https (or http on localhost).');
  return url.origin;
}

const b64url = (b: Buffer) => b.toString('base64url');

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
      `<h1 style="font-size:1.2rem">${title}</h1><p>${body}</p></body>`,
  );
}

/**
 * Waits for the browser to come back to our loopback listener. Only
 * `GET /callback` with our exact `state` counts; anything else is answered and
 * ignored, so another local process can't cut the sign-in short.
 */
class LoopbackReceiver {
  private server: Server;
  private settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  readonly result: Promise<string>;

  constructor(private readonly state: string) {
    this.result = new Promise<string>((resolve, reject) => (this.settle = { resolve, reject }));
    this.result.catch(() => undefined);
    this.server = createServer((req, res) => this.onRequest(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new AccountError('Could not start the sign-in listener.');
    return `http://127.0.0.1:${address.port}/callback`;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') return page(res, 404, 'Not found', '');
    const state = url.searchParams.get('state') ?? '';
    if (!sameSecret(state, this.state)) return page(res, 400, 'Sign-in link not recognised', 'Start signing in again from Margin.');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) {
      page(res, 200, 'Sign-in didn’t complete', 'You can close this tab and try again from Margin.');
      return this.settle.reject(
        new AccountError(
          url.searchParams.get('error') === 'access_denied'
            ? 'Sign-in was cancelled, or this GitHub account isn’t allowed on this server.'
            : 'The server couldn’t complete sign-in. Try again.',
        ),
      );
    }
    page(res, 200, 'Signed in to Margin', 'You can close this tab and return to Margin.');
    this.settle.resolve(code);
  }

  cancel(error: Error): void {
    this.settle.reject(error);
  }

  close(): void {
    this.server.close();
    this.server.closeAllConnections();
  }
}

export class AccountManager {
  private session: Session | null = null;
  private signingIn: { cancel: (e: Error) => void } | null = null;
  private lastError: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AccountOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Reads the saved session, if any. No network. */
  async load(): Promise<void> {
    try {
      const sealed = await fs.readFile(this.options.file);
      if (!this.options.secretBox.available()) return;
      const s = JSON.parse(this.options.secretBox.decrypt(sealed)) as Session;
      if (s?.v === 1 && typeof s.token === 'string' && typeof s.serverUrl === 'string') this.session = s;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Margin: ignoring an unreadable account file');
        await fs.rm(this.options.file, { force: true });
      }
    }
  }

  private serverOrigin(): string {
    return parseServerUrl(this.options.serverUrl());
  }

  /** The session, but only if it belongs to the currently configured server. */
  private activeSession(): Session | null {
    try {
      return this.session && this.session.serverUrl === this.serverOrigin() ? this.session : null;
    } catch {
      return null;
    }
  }

  status(): AccountStatus {
    let serverUrl: string;
    try {
      serverUrl = this.serverOrigin();
    } catch {
      serverUrl = this.options.serverUrl();
    }
    if (this.signingIn) return { state: 'signing-in', serverUrl };
    const s = this.activeSession();
    if (s) return { state: 'signed-in', serverUrl, login: s.login, deviceId: s.deviceId };
    return { state: 'signed-out', serverUrl, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  private changed(): void {
    this.options.onChange?.(this.status());
  }

  /**
   * Runs the whole browser round trip. Calling it again while one is pending
   * cancels the pending one (the user closed the tab and clicked Sign In again).
   */
  async signIn(): Promise<AccountStatus> {
    this.signingIn?.cancel(new AccountError('Sign-in was restarted.'));
    const server = this.serverOrigin();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));
    const receiver = new LoopbackReceiver(state);
    const mine = { cancel: (e: Error) => receiver.cancel(e) };
    this.signingIn = mine;
    this.lastError = undefined;
    this.changed();
    const timer = setTimeout(
      () => receiver.cancel(new AccountError('Sign-in timed out. Try again.')),
      this.options.signInTimeoutMs ?? 5 * 60_000,
    );
    try {
      const redirectUri = await receiver.listen();
      const start = new URL('/api/auth/native/start', server);
      start.search = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        device_name: this.options.deviceName(),
      }).toString();
      await this.options.openExternal(start.toString());
      const code = await receiver.result;
      const res = await this.fetchImpl(new URL('/api/auth/native/token', server), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri, device_name: this.options.deviceName() }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new AccountError('The server refused the sign-in. Try again.');
      const body = (await res.json()) as NativeTokenResponse;
      if (typeof body.token !== 'string' || !DEVICE_ID.test(body.device?.id ?? '')) throw new AccountError('Unexpected server response.');
      await this.save({ v: 1, serverUrl: server, token: body.token, deviceId: body.device.id, login: body.login });
      if (this.signingIn === mine) this.signingIn = null;
      return this.status();
    } catch (error) {
      if (this.signingIn === mine) this.lastError = error instanceof AccountError ? error.message : 'Couldn’t reach the server.';
      throw error instanceof AccountError ? error : new AccountError('Couldn’t reach the server.');
    } finally {
      clearTimeout(timer);
      receiver.close();
      if (this.signingIn === mine) this.signingIn = null;
      this.changed();
    }
  }

  /**
   * Revokes this device on the server, then forgets the token locally whatever
   * happens. If the server didn't confirm the revoke (offline, 5xx…), the token
   * may still be valid there: say so, and point to Account and Devices.
   */
  async signOut(): Promise<AccountStatus> {
    let warning: string | undefined;
    if (this.activeSession()) {
      try {
        const res = await this.request('POST', '/api/auth/signout');
        if (res.status !== 204 && res.status !== 200) warning = SIGN_OUT_UNCONFIRMED;
      } catch (error) {
        // A 401 means the token was already dead (request() cleared it): nothing to warn about.
        if (!(error instanceof AccountError && this.session === null && /revoked or expired/.test(error.message))) {
          warning = SIGN_OUT_UNCONFIRMED;
        }
      }
    }
    await this.clear();
    this.lastError = warning;
    this.changed();
    return this.status();
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const res = await this.request('GET', '/api/devices');
    if (!res.ok) throw new AccountError('Couldn’t load devices.');
    return parseDevices(((await res.json()) as { devices?: unknown }).devices);
  }

  async revokeDevice(id: string): Promise<AccountStatus> {
    if (!DEVICE_ID.test(id)) throw new AccountError('Unknown device.');
    const self = this.activeSession()?.deviceId === id;
    const res = await this.request('DELETE', `/api/devices/${id}`);
    if (res.status !== 204 && res.status !== 404) throw new AccountError('Couldn’t revoke the device.');
    if (self) await this.clear();
    return this.status();
  }

  /**
   * An authenticated request to the configured server (M5 sync uses this too).
   * A 401 means the token was revoked or expired: we forget it and report
   * signed out.
   */
  async request(
    method: string,
    pathname: string,
    init: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const s = this.activeSession();
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
    const res = await this.fetchImpl(new URL(pathname, s.serverUrl), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      redirect: 'error', // never follow a redirect with the token attached
    });
    if (res.status === 401) {
      await this.clear();
      this.lastError = 'This device was signed out (revoked or expired).';
      this.changed();
      throw new AccountError(this.lastError);
    }
    return res;
  }

  private async save(session: Session): Promise<void> {
    this.session = session;
    if (!this.options.secretBox.available()) {
      // Never write the token in plain text; keep it for this run only.
      console.warn('Margin: OS encryption unavailable; staying signed in for this session only');
      return;
    }
    const dir = path.dirname(this.options.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.session-${randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, this.options.secretBox.encrypt(JSON.stringify(session)), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, this.options.file);
  }

  private async clear(): Promise<void> {
    this.session = null;
    await fs.rm(this.options.file, { force: true });
    this.changed();
  }
}
