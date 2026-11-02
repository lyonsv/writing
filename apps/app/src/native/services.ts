import { NATIVE_CUSTOM_SCHEME_REDIRECT, defaultServerUrl as builtInDefault } from '@margin/core';
import { sha256 } from '@noble/hashes/sha256';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { AppState } from 'react-native';

import { NativeAccount, type SecretStore } from './account';
import { ExpoFs } from './expoFs';
import { flushWorkspace } from '../local/lifecycle';
import { NativeLibrary } from '../local/library';
import { FileSettingsStore } from '../local/settings';
import { NativeSyncService } from '../local/sync';

/**
 * The iOS app's singletons (ADR 0015): the library in the documents directory,
 * file-backed settings, the Keychain-backed account and the sync service, plus
 * the app-lifecycle wiring: flush on background/inactive, sync on foreground
 * and a few seconds after edits.
 */

const secrets: SecretStore = {
  get: (k) => SecureStore.getItemAsync(k),
  // This device only: not in iCloud Keychain, not restored onto another phone from a backup.
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  delete: (k) => SecureStore.deleteItemAsync(k),
};

/**
 * Server: Settings › Server, else EXPO_PUBLIC_MARGIN_SERVER_URL, else production in
 * release builds and http://127.0.0.1:3000 in development (Expo Go). On a physical
 * phone 127.0.0.1 is the phone itself: use Settings › Server (one tap for production)
 * or a LAN address.
 */
const ENV_SERVER_URL = process.env.EXPO_PUBLIC_MARGIN_SERVER_URL;

export const fs = new ExpoFs();
export const library = new NativeLibrary({ fs });
export const settingsStore = new FileSettingsStore(fs);
export const ready: Promise<void> = library.init();

export const defaultServerUrl = () => ENV_SERVER_URL || builtInDefault(!__DEV__);
let serverUrl = defaultServerUrl();

export const account = new NativeAccount({
  secrets,
  openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256: (b) => sha256(b),
  fetch: (input, init) => fetch(input, init),
  serverUrl: () => serverUrl,
  deviceName: () => Constants.deviceName ?? 'iPhone',
  allowInsecureLan: __DEV__,
  redirectUri: NATIVE_CUSTOM_SCHEME_REDIRECT,
});

export { setWorkspaceFlush } from '../local/lifecycle';

export const sync = new NativeSyncService({
  library,
  fs,
  account,
  beforeSync: () => flushWorkspace(),
});

let syncing = false;
sync.onChange((s) => {
  syncing = s.state === 'syncing';
});
// Edits (and creates, renames, deletes) nudge a sync; sync's own writes don't.
library.onChange(() => {
  if (!syncing) sync.nudge();
});

void settingsStore.load().then((s) => {
  serverUrl = s.serverUrl || defaultServerUrl();
  account.notify();
});
settingsStore.subscribe((s) => {
  const next = s.serverUrl || defaultServerUrl();
  if (next !== serverUrl) {
    serverUrl = next;
    account.notify();
  }
});

account.onChange((s) => {
  if (s.state === 'signed-in') sync.resume();
  else if (s.state === 'signed-out') void sync.syncNow(); // reports "off"
});

let started = false;
/** Called once from the root layout. */
export function startLifecycle(): void {
  if (started) return;
  started = true;
  void ready.then(() => account.load()).then(() => sync.resume());
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      sync.resume();
    } else {
      // background / inactive: get every keystroke to disk now; iOS may suspend or kill us next.
      sync.pause();
      // No background-task API in Expo Go (beginBackgroundTask needs a native module); iOS
      // normally allows a few seconds after backgrounding, which a local flush fits in.
      void flushWorkspace()
        .then((clean) => {
          if (!clean) console.warn('Margin: the editor did not confirm its flush before going to the background');
        })
        .then(() => library.idle())
        .then(() => settingsStore.flushed())
        .catch((e: unknown) => console.error('Margin: flush on background failed', e));
    }
  });
}
