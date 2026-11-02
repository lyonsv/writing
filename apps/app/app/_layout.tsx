import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: dark ? '#1b1b1c' : '#fbfbfa' },
        }}
      />
    </>
  );
}
