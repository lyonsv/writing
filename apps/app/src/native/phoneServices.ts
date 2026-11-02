import Constants from 'expo-constants';

import type { PhoneServices } from '../../components/phone/context';
import { parseServerUrl } from './account';
import { inlineFontCss } from './fonts';
import { account, defaultServerUrl, library, sync } from './services';

/** What the shared phone screens need on iOS. */
export const nativePhoneServices: PhoneServices = {
  library,
  sync,
  account,
  fontCss: () => inlineFontCss(),
  server: { defaultUrl: defaultServerUrl, parse: (raw) => parseServerUrl(raw, __DEV__), showDevButton: __DEV__ },
  label: 'iPhone',
  version: Constants.expoConfig?.version ?? '',
  storageLabel: `app Documents/${library.root}`,
};
