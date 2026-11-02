import type { AccountBackend } from '@margin/core';

import { getDesktopBridge } from '../storage/documentStore';
import { unavailableAccountBackend } from './unavailable';

let backend: AccountBackend | undefined;

/** Desktop: IPC into main, which holds the token. Browser: not available (cookie sign-in is server-side). */
export function getAccountBackend(): AccountBackend {
  if (!backend) {
    const bridge = getDesktopBridge();
    backend = bridge
      ? { available: true, ...bridge.account }
      : unavailableAccountBackend('Sign-in is available in the Margin desktop app.');
  }
  return backend;
}
