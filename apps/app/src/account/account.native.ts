import type { AccountBackend } from '@margin/core';

import { unavailableAccountBackend } from './unavailable';

let backend: AccountBackend | undefined;

/** iOS sign-in arrives in M6 (expo-auth-session with margin://auth/callback, token in expo-secure-store). */
export function getAccountBackend(): AccountBackend {
  backend ??= unavailableAccountBackend('Sign-in on iOS arrives in a later version.');
  return backend;
}
