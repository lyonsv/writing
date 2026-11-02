import type { AccountBackend, AccountStatus } from '@margin/core';

/**
 * Where sign-in isn't wired up yet: a plain browser (the hosted web build
 * signs in with a server cookie instead, see ADR 0010) and iOS until M6
 * (expo-auth-session + expo-secure-store). The library never depends on this.
 */
export function unavailableAccountBackend(reason: string): AccountBackend {
  const status: AccountStatus = { state: 'signed-out', serverUrl: '', error: reason };
  const fail = () => Promise.reject(new Error(reason));
  return {
    available: false,
    status: async () => status,
    signIn: fail,
    signOut: async () => status,
    listDevices: fail,
    revokeDevice: fail,
    onChange: () => () => undefined,
  };
}
