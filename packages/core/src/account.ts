/**
 * Account / device contract shared by the server (`apps/server`), the desktop
 * main process and the app UI. Types and pure constants only: no Node, DOM or
 * crypto here (see ADR 0001). See docs/decisions/0010-auth-model.md.
 */

/** A signed-in device (or browser session) as the server reports it. Never contains the token. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** `native` = bearer token (desktop/iOS); `web` = cookie session of the hosted web build. */
  kind: 'native' | 'web';
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** True for the device whose token made this request. */
  current?: boolean;
}

/** `GET /api/me`. */
export interface MeResponse {
  login: string;
  githubId: number;
  device: DeviceInfo;
}

/** `POST /api/auth/native/token` request body (RFC 8252 + PKCE, see ADR 0011). */
export interface NativeTokenRequest {
  code: string;
  code_verifier: string;
  redirect_uri: string;
  device_name?: string;
}

/** `POST /api/auth/native/token` response. */
export interface NativeTokenResponse {
  /** Opaque bearer token, `mgn_<deviceId>.<secret>`. Shown exactly once. */
  token: string;
  login: string;
  device: DeviceInfo;
}

/** The custom-scheme redirect for iOS (M6, expo-auth-session). */
export const NATIVE_CUSTOM_SCHEME_REDIRECT = 'margin://auth/callback';

/** What the desktop renderer may know about the account. The token never crosses into the renderer. */
export type AccountStatus =
  /** `error`: why the last sign-in attempt failed or why the device was signed out. */
  | { state: 'signed-out'; serverUrl: string; error?: string }
  | { state: 'signing-in'; serverUrl: string }
  | { state: 'signed-in'; serverUrl: string; login: string; deviceId: string };

/** Renderer-side account operations; on desktop each is an IPC call into main. */
export interface AccountBackend {
  /** False where sign-in isn't wired up yet (browser, iOS until M6). */
  readonly available: boolean;
  status(): Promise<AccountStatus>;
  signIn(): Promise<AccountStatus>;
  signOut(): Promise<AccountStatus>;
  listDevices(): Promise<DeviceInfo[]>;
  /** Revoking the current device signs this device out. */
  revokeDevice(id: string): Promise<AccountStatus>;
  onChange(listener: (status: AccountStatus) => void): () => void;
}

/** Validates a `DeviceInfo` array coming over the network or IPC. Drops malformed entries. */
export function parseDevices(input: unknown): DeviceInfo[] {
  if (!Array.isArray(input)) return [];
  const out: DeviceInfo[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const d = raw as Record<string, unknown>;
    if (
      typeof d.id !== 'string' ||
      typeof d.name !== 'string' ||
      (d.kind !== 'native' && d.kind !== 'web') ||
      typeof d.createdAt !== 'string' ||
      typeof d.lastUsedAt !== 'string' ||
      typeof d.expiresAt !== 'string'
    ) {
      continue;
    }
    out.push({
      id: d.id,
      name: d.name,
      kind: d.kind,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
      expiresAt: d.expiresAt,
      current: d.current === true,
    });
  }
  return out;
}
