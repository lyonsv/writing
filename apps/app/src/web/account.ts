import {
  parseDevices,
  type AccountBackend,
  type AccountStatus,
  type DeviceInfo,
  type SyncHttpRequest,
  type SyncHttpResponse,
} from '@margin/core';

/**
 * The hosted web app's account (ADR 0020): the server's HttpOnly cookie
 * session (`__Host-margin_session`, ADR 0010) on the same origin. JavaScript
 * never sees a token. Writes carry the browser's `Origin` header, which the
 * server checks (CSRF); SameSite=Lax withholds the cookie from other sites.
 *
 * The last known identity (login, device id: not secrets) is remembered so the
 * app keeps working offline as "signed in" and syncs when the network returns.
 */
export class AccountError extends Error {
  override name = 'AccountError';
}

const LAST_KEY = 'margin.account.v1';

export interface WebAccountDeps {
  fetch: typeof fetch;
  origin: string;
  storage?: Storage;
  /** Full-page navigation (sign-in, after sign-out). */
  navigate: (url: string) => void;
  /** Called after sign-out: drop cached app shell and data a signed-out page mustn't keep. */
  onSignedOut?: () => Promise<void>;
}

export class WebAccount implements AccountBackend {
  readonly available = true;
  private last: { login: string; deviceId: string } | null = null;
  private signedOut = false;
  private error: string | undefined;
  private listeners = new Set<(s: AccountStatus) => void>();

  constructor(private readonly deps: WebAccountDeps) {
    try {
      const raw = deps.storage?.getItem(LAST_KEY);
      if (raw) this.last = JSON.parse(raw) as { login: string; deviceId: string };
    } catch {
      /* none */
    }
  }

  current(): AccountStatus & { login?: string } {
    const serverUrl = this.deps.origin;
    if (this.last && !this.signedOut) return { state: 'signed-in', serverUrl, login: this.last.login, deviceId: this.last.deviceId };
    return { state: 'signed-out', serverUrl, ...(this.error ? { error: this.error } : {}) };
  }

  private remember(v: { login: string; deviceId: string } | null): void {
    this.last = v;
    try {
      if (v) this.deps.storage?.setItem(LAST_KEY, JSON.stringify(v));
      else this.deps.storage?.removeItem(LAST_KEY);
    } catch {
      /* private mode */
    }
    this.notify();
  }

  private notify(): void {
    const s = this.current();
    for (const l of this.listeners) l(s);
  }

  onChange(listener: (s: AccountStatus) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private leaving = false;

  /**
   * Any 401 (revoked, expired, de-allowlisted): signed out, exactly like Sign Out
   * (validator M8): the cached app shell is dropped and the page goes to the
   * sign-in page. The documents in this browser's IndexedDB are kept; they are
   * the user's, and they sync again after signing back in (ADR 0020).
   */
  private async sessionLost(reason: string): Promise<void> {
    this.signedOut = true;
    this.error = reason;
    this.remember(null);
    if (this.leaving) return;
    this.leaving = true;
    await this.deps.onSignedOut?.().catch(() => undefined);
    this.deps.navigate('/');
  }

  /** Asks the server who we are. Offline: keeps the last known answer. */
  async status(): Promise<AccountStatus> {
    try {
      const res = await this.deps.fetch('/api/me', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
      if (res.status === 401) {
        await this.sessionLost('This browser was signed out (revoked or expired).');
      } else if (res.ok) {
        const me = (await res.json()) as { login: string; device: { id: string } };
        this.signedOut = false;
        if (me.login !== this.last?.login || me.device.id !== this.last?.deviceId) this.remember({ login: me.login, deviceId: me.device.id });
      }
    } catch {
      /* offline: last known */
    }
    return this.current();
  }

  async signIn(): Promise<AccountStatus> {
    const here = typeof location !== 'undefined' ? location.pathname : '/';
    this.deps.navigate(`/api/auth/web/start?return_to=${encodeURIComponent(here)}`);
    return { state: 'signing-in', serverUrl: this.deps.origin };
  }

  async signOut(): Promise<AccountStatus> {
    try {
      await this.deps.fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin', redirect: 'error' });
    } catch {
      this.error = 'Signed out here, but the server didn’t confirm it. Revoke this browser in Account and Devices on another device.';
    }
    this.signedOut = true;
    this.remember(null);
    await this.deps.onSignedOut?.();
    this.deps.navigate('/');
    return this.current();
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const res = await this.request('GET', '/api/devices');
    if (!res.ok) throw new AccountError('Couldn’t load devices.');
    return parseDevices(((await res.json()) as { devices?: unknown }).devices);
  }

  async revokeDevice(id: string): Promise<AccountStatus> {
    const res = await this.request('DELETE', `/api/devices/${encodeURIComponent(id)}`);
    if (res.status !== 204 && res.status !== 404) throw new AccountError('Couldn’t revoke the device.');
    if (this.last?.deviceId === id) {
      this.signedOut = true;
      this.remember(null);
      await this.deps.onSignedOut?.();
      this.deps.navigate('/');
    }
    return this.current();
  }

  /** Same-origin, cookie-authenticated; 401 = signed out (revoked/expired). Used by sync. */
  request: SyncHttpRequest = async (method, pathname, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
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
      res = await this.deps.fetch(pathname, {
        method,
        headers,
        body,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      await this.sessionLost('This browser was signed out (revoked or expired).');
      throw new AccountError(this.error);
    }
    return res as SyncHttpResponse & Response;
  };
}
