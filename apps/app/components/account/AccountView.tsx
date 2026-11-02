import type { AccountBackend, AccountStatus, DeviceInfo } from '@margin/core';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SidebarColors } from '../library/Sidebar';

export interface AccountViewProps {
  backend: AccountBackend;
  colors: SidebarColors;
  onClose: () => void;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const message = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') : String(e);

/**
 * Account / Devices panel, in React Native primitives so iOS (M6) can reuse it
 * with its own `AccountBackend`. Shows who is signed in, the devices with
 * access, and lets you revoke any of them. Never sees a token.
 */
export function AccountView({ backend, colors, onClose }: AccountViewProps) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await backend.listDevices());
      setError(null);
    } catch (e) {
      setDevices(null);
      setError(message(e));
    }
  }, [backend]);

  useEffect(() => {
    let live = true;
    void backend.status().then((s) => live && setStatus(s));
    const off = backend.onChange((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [backend]);

  useEffect(() => {
    if (status?.state === 'signed-in') void loadDevices();
    else setDevices(null);
  }, [status?.state, loadDevices]);

  const act = async (fn: () => Promise<AccountStatus>) => {
    setError(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(message(e));
    }
  };

  const revoke = async (id: string) => {
    if (confirming !== id) return setConfirming(id);
    setConfirming(null);
    await act(() => backend.revokeDevice(id));
    if (status?.state === 'signed-in') await loadDevices();
  };

  const text = { color: colors.text };
  const muted = { color: colors.muted };
  const shownError = error ?? (status?.state === 'signed-out' ? status.error : undefined);

  return (
    <Pressable testID="account-view" style={styles.backdrop} onPress={onClose}>
      <Pressable style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.muted }]} onPress={() => {}}>
        <View style={styles.header}>
          <Text style={[styles.title, text]}>Account</Text>
          <Pressable testID="account-close" onPress={onClose} hitSlop={8} accessibilityLabel="Close">
            <Text style={[styles.button, muted]}>Close</Text>
          </Pressable>
        </View>

        {!status ? null : status.state === 'signed-in' ? (
          <>
            <Text testID="account-status" style={[styles.line, text]}>
              Signed in as {status.login}
            </Text>
            <Text style={[styles.small, muted]} numberOfLines={1}>
              {status.serverUrl}
            </Text>
            <Text style={[styles.section, muted]}>DEVICES</Text>
            <ScrollView style={styles.list}>
              {(devices ?? []).map((d) => (
                <View key={d.id} testID={`account-device:${d.id}`} style={styles.device}>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[styles.line, text]}>
                      {d.name}
                      {d.current ? <Text style={muted}>  · this device</Text> : null}
                    </Text>
                    <Text style={[styles.small, muted]}>
                      Added {when(d.createdAt)} · last used {when(d.lastUsedAt)} · expires {when(d.expiresAt)}
                    </Text>
                  </View>
                  <Pressable testID={`account-revoke:${d.id}`} onPress={() => void revoke(d.id)} hitSlop={6}>
                    <Text style={[styles.button, { color: colors.danger }]}>{confirming === d.id ? 'Confirm' : 'Revoke'}</Text>
                  </Pressable>
                </View>
              ))}
              {devices === null && !shownError ? <Text style={[styles.small, muted]}>Loading…</Text> : null}
            </ScrollView>
            <Pressable testID="account-sign-out" onPress={() => void act(() => backend.signOut())} style={styles.action}>
              <Text style={[styles.button, text]}>Sign Out</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text testID="account-status" style={[styles.line, text]}>
              {status.state === 'signing-in' ? 'Waiting for your browser…' : 'Not signed in'}
            </Text>
            <Text style={[styles.small, muted]}>
              Your documents stay on this device whether or not you sign in. Signing in will let Margin sync them (coming soon).
            </Text>
            {backend.available ? (
              <Pressable
                testID="account-sign-in"
                onPress={() => void act(() => backend.signIn())}
                style={styles.action}
              >
                <Text style={[styles.button, text]}>{status.state === 'signing-in' ? 'Restart Sign In…' : 'Sign In with GitHub…'}</Text>
              </Pressable>
            ) : null}
          </>
        )}

        {shownError ? (
          <Text testID="account-error" style={[styles.small, { color: colors.danger, marginTop: 8 }]}>
            {shownError}
          </Text>
        ) : null}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: '10%' },
  panel: { width: 520, maxWidth: '90%', maxHeight: '70%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 16, fontWeight: '600' },
  line: { fontSize: 14 },
  small: { fontSize: 12, marginTop: 2 },
  section: { fontSize: 11, letterSpacing: 0.8, marginTop: 16, marginBottom: 4 },
  list: { flexGrow: 0 },
  device: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12 },
  action: { marginTop: 14, alignSelf: 'flex-start' },
  button: { fontSize: 13 },
});
