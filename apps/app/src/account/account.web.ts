import type { AccountBackend } from '@margin/core';

import { getDesktopBridge } from '../storage/documentStore';
import { webServices } from '../web/services';
import { unavailableAccountBackend } from './unavailable';

let backend: AccountBackend | undefined;

/**
 * Desktop: IPC into main, which holds the token. Hosted web app: the server's
 * cookie session (ADR 0020). A browser not served by a Margin server
 * (`pnpm dev:web`): unavailable.
 */
export function getAccountBackend(): AccountBackend {
  if (!backend) {
    const bridge = getDesktopBridge();
    backend = bridge
      ? { available: true, ...bridge.account }
      : (webServices().account ?? unavailableAccountBackend('Sign-in is available when Margin is served by your Margin server, and in the desktop app.'));
  }
  return backend;
}
