import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { PhoneProvider, type PhoneNav } from '../components/phone/context';
import { nativePhoneServices } from '../src/native/phoneServices';
import { startLifecycle } from '../src/native/services';
import { WorkspaceProvider } from '../src/WorkspaceContext';

/**
 * iOS: a stack of Library → Editor (→ Settings), sharing one workspace. The
 * screens themselves are shared with the web app on a phone
 * (components/phone, ADR 0016/0020).
 */
export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  const router = useRouter();
  const [searchRequest, setSearchRequest] = useState(0);
  useEffect(() => startLifecycle(), []);
  const nav = useMemo<PhoneNav>(
    () => ({
      openEditor: () => router.push('/editor'),
      openLibrary: (o) => {
        router.navigate('/');
        if (o?.search) setSearchRequest((n) => n + 1);
      },
      openSettings: () => router.push('/settings'),
      closeSettings: () => router.back(),
      searchRequest,
    }),
    [router, searchRequest],
  );
  return (
    <WorkspaceProvider>
      <PhoneProvider value={{ nav, services: nativePhoneServices }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: dark ? '#1b1b1c' : '#fbfbfa' } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="editor" options={{ gestureEnabled: true }} />
          <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
        </Stack>
      </PhoneProvider>
    </WorkspaceProvider>
  );
}
