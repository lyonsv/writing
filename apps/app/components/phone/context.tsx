import type { AccountBackend } from '@margin/core';
import { createContext, useContext } from 'react';
import { Alert, Platform } from 'react-native';

import type { NativeLibrary } from '../../src/local/library';
import type { NativeSyncService } from '../../src/local/sync';

/**
 * The phone screens (Library, Editor, Settings) run on iOS (Expo Router stack)
 * and in the web app on a phone (one route, in-component navigation). The
 * platform supplies how to navigate and its services through this context.
 */
export interface PhoneNav {
  openEditor(): void;
  openLibrary(options?: { search?: boolean }): void;
  openSettings(): void;
  closeSettings(): void;
  /** Bumped when the library should open its search (⌘P from the editor). */
  searchRequest: number;
}

export interface PhoneServices {
  library: NativeLibrary;
  /** Null where there's no server (e.g. `pnpm dev:web`). */
  sync: NativeSyncService | null;
  account: AccountBackend;
  /** iOS: inline font CSS for the WebView; web: null (fonts load by URL). */
  fontCss(): Promise<string | null>;
  /** iOS: a configurable server. Web: the page's own origin, so null. */
  server: null | { defaultUrl(): string; parse(raw: string): string; showDevButton: boolean };
  /** "iPhone" or "browser", in messages. */
  label: string;
  version: string;
  /** Where documents live, for diagnostics. */
  storageLabel: string;
}

const Ctx = createContext<{ nav: PhoneNav; services: PhoneServices } | null>(null);
export const PhoneProvider = Ctx.Provider;

export function usePhone() {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePhone outside PhoneProvider');
  return v;
}

/** RN `Alert` on iOS; `window.confirm` on web (react-native-web's Alert does nothing). */
export function confirmAction(title: string, message: string, action: string, destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]),
  );
}
