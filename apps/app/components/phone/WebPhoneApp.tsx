import Constants from 'expo-constants';
import { useMemo, useState } from 'react';

import { getAccountBackend } from '../../src/account/account';
import { webServices } from '../../src/web/services';
import { WorkspaceProvider } from '../../src/WorkspaceContext';
import { PhoneProvider, type PhoneNav, type PhoneServices } from './context';
import { EditorScreen } from './EditorScreen';
import { LibraryScreen } from './LibraryScreen';
import { SettingsScreen } from './SettingsScreen';

type Screen = 'library' | 'editor' | 'settings';

/**
 * The web app on a phone (installed to the home screen; ADR 0020): the same
 * Library / Editor / Settings screens as iOS (M6), with in-component
 * navigation instead of a native stack.
 */
export function WebPhoneApp() {
  const [screen, setScreen] = useState<Screen>('library');
  const [returnTo, setReturnTo] = useState<Screen>('library');
  const [searchRequest, setSearchRequest] = useState(0);
  const services = useMemo<PhoneServices>(() => {
    const s = webServices();
    return {
      library: s.library,
      sync: s.sync,
      account: getAccountBackend(),
      fontCss: async () => null, // the browser loads the font files by URL
      server: null, // always this site's own server
      label: 'device',
      version: Constants.expoConfig?.version ?? '',
      storageLabel: 'this browser (IndexedDB)',
    };
  }, []);
  const nav = useMemo<PhoneNav>(
    () => ({
      openEditor: () => setScreen('editor'),
      openLibrary: (o) => {
        setScreen('library');
        if (o?.search) setSearchRequest((n) => n + 1);
      },
      openSettings: () => {
        setReturnTo((prev) => (screen === 'settings' ? prev : screen));
        setScreen('settings');
      },
      closeSettings: () => setScreen(returnTo),
      searchRequest,
    }),
    [screen, returnTo, searchRequest],
  );
  return (
    <WorkspaceProvider>
      <PhoneProvider value={{ nav, services }}>
        {screen === 'library' ? <LibraryScreen /> : screen === 'editor' ? <EditorScreen /> : <SettingsScreen />}
      </PhoneProvider>
    </WorkspaceProvider>
  );
}
