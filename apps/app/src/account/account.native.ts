import type { AccountBackend } from '@margin/core';

import { account } from '../native/services';

/** iOS: margin:// sign-in through an auth session, token in the Keychain (ADR 0017). */
export function getAccountBackend(): AccountBackend {
  return account;
}
