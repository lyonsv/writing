import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { startLifecycle } from '../src/native/services';
import { WorkspaceProvider } from '../src/WorkspaceContext';

/**
 * iOS: a stack of Library → Editor (→ Settings), sharing one workspace.
 * The status bar is set per screen (hidden in focus mode). ADR 0016.
 */
export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  useEffect(() => startLifecycle(), []);
  return (
    <WorkspaceProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: dark ? '#1b1b1c' : '#fbfbfa' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="editor" options={{ gestureEnabled: true }} />
        <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
      </Stack>
    </WorkspaceProvider>
  );
}
