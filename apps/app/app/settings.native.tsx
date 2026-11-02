import { DEV_SERVER_URL, PRODUCTION_SERVER_URL, type FocusScopeSetting } from '@margin/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountView } from '../components/account/AccountView';
import { parseServerUrl } from '../src/native/account';
import { diagnostics, onDiagnostics } from '../src/native/diagnostics';
import type { TrashItem } from '../src/native/library';
import { DARK, LIGHT } from '../src/native/palette';
import { account, defaultServerUrl, library, sync } from '../src/native/services';
import { syncLabel, useSyncStatus } from '../src/useSyncStatus';
import { useShared } from '../src/WorkspaceContext';

/** iOS settings (modal): writing, account and devices, sync, server, Recently Deleted, diagnostics. */
export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColorScheme() === 'dark' ? DARK : LIGHT;
  const { settings, update, ws } = useShared();
  const syncStatus = useSyncStatus();
  const [server, setServer] = useState(settings.serverUrl ?? '');
  const [serverError, setServerError] = useState<string | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [diag, setDiag] = useState(() => [...diagnostics()]);

  const loadTrash = () => void library.listTrash().then(setTrash).catch(() => setTrash([]));
  useEffect(loadTrash, []);
  useEffect(() => onDiagnostics(() => setDiag([...diagnostics()])), []);

  const text = { color: colors.text };
  const muted = { color: colors.muted };

  const saveServer = async (value: string) => {
    setServerError(null);
    const v = value.trim();
    if (v === '') {
      await update({ serverUrl: '' });
      setServer('');
      return;
    }
    try {
      const origin = parseServerUrl(v, __DEV__);
      await update({ serverUrl: origin });
      setServer(origin);
    } catch (e) {
      setServerError((e as Error).message);
    }
  };

  const scopes: Array<[FocusScopeSetting, string]> = [
    ['sentence', 'Sentence'],
    ['paragraph', 'Paragraph'],
    ['off', 'Nothing'],
  ];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, text]} accessibilityRole="header">
          Settings
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button">
          <Text style={[styles.link, { color: colors.text, fontWeight: '600' }]}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
        <Text style={[styles.section, muted]}>WRITING</Text>
        <Text style={[styles.label, text]}>In focus mode, keep undimmed</Text>
        <View style={styles.segments} accessibilityRole="radiogroup">
          {scopes.map(([value, label]) => (
            <Pressable
              key={value}
              onPress={() => void update({ focusScope: value })}
              style={[styles.segment, { borderColor: colors.muted }, settings.focusScope === value && { backgroundColor: colors.active }]}
              accessibilityRole="radio"
              accessibilityState={{ selected: settings.focusScope === value }}
            >
              <Text style={[styles.body, text]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Row label="Focus mode" colors={colors}>
          <Switch value={settings.focusMode} onValueChange={(v) => void update({ focusMode: v })} />
        </Row>
        <Row label="Typewriter scrolling" colors={colors}>
          <Switch value={settings.typewriter} onValueChange={(v) => void update({ typewriter: v })} />
        </Row>
        <Text style={[styles.small, muted]}>Text size follows iOS Settings › Display & Brightness › Text Size.</Text>

        <Text style={[styles.section, muted]}>ACCOUNT</Text>
        <AccountView backend={account} colors={colors} onClose={() => undefined} inline />

        <Text style={[styles.section, muted]}>SYNC</Text>
        <Text style={[styles.body, syncStatus?.state === 'error' ? { color: colors.danger } : text]}>
          {syncLabel(syncStatus) ?? 'Off (not signed in)'}
        </Text>
        <View style={styles.buttons}>
          <Button label="Sync Now" colors={colors} onPress={() => void sync.syncNow().then(() => ws.refresh())} />
          <Button
            label="Reset Sync State…"
            colors={colors}
            onPress={() =>
              Alert.alert(
                'Reset sync state?',
                'Margin compares everything on this iPhone with the server again. Nothing is deleted; where the two differ, this iPhone’s version is kept as a conflict copy. Use this if sync says the server’s copy is older than this iPhone’s.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Reset', onPress: () => void sync.resetBase().then(() => ws.refresh()) },
                ],
              )
            }
          />
        </View>

        <Text style={[styles.section, muted]}>SERVER</Text>
        <TextInput
          value={server}
          onChangeText={setServer}
          onSubmitEditing={() => void saveServer(server)}
          onBlur={() => void saveServer(server)}
          placeholder={defaultServerUrl()}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, text, { borderColor: colors.muted }]}
          accessibilityLabel="Server URL"
        />
        {serverError ? <Text style={[styles.small, { color: colors.danger }]}>{serverError}</Text> : null}
        <Text style={[styles.small, muted]}>
          Empty uses the default ({defaultServerUrl()}). Signing in is per server: changing it signs this iPhone out of the old one locally.
        </Text>
        <View style={styles.buttons}>
          <Button label="Use production" colors={colors} onPress={() => void saveServer(PRODUCTION_SERVER_URL)} />
          {__DEV__ ? <Button label="Local dev" colors={colors} onPress={() => void saveServer(DEV_SERVER_URL)} /> : null}
        </View>

        <Text style={[styles.section, muted]}>RECENTLY DELETED</Text>
        {trash.length === 0 ? <Text style={[styles.small, muted]}>Nothing. Deleted documents stay here for 30 days.</Text> : null}
        {trash.map((t) => (
          <View key={t.id} style={styles.trashRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.body, text]} numberOfLines={1}>
                {t.originalPath}
              </Text>
              <Text style={[styles.small, muted]}>{new Date(t.deletedAt).toLocaleString()}</Text>
            </View>
            <Button
              label="Restore"
              colors={colors}
              onPress={() =>
                void library
                  .restore(t.id)
                  .then(() => ws.refresh())
                  .finally(loadTrash)
              }
            />
          </View>
        ))}
        {trash.length > 0 ? (
          <Button
            label="Delete All Permanently…"
            danger
            colors={colors}
            onPress={() =>
              Alert.alert('Delete permanently?', 'These documents can’t be recovered afterwards.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => void library.purgeTrash(true).finally(loadTrash) },
              ])
            }
          />
        ) : null}

        <Text style={[styles.section, muted]}>DIAGNOSTICS</Text>
        {diag.length === 0 ? <Text style={[styles.small, muted]}>Open a document to check the editor font.</Text> : null}
        {diag.map(([k, v]) => (
          <Text key={k} style={[styles.small, text]} selectable>
            {k}: {v}
          </Text>
        ))}
        <Text style={[styles.small, muted]} selectable>
          Library: app Documents/{library.root} · server {settings.serverUrl || defaultServerUrl()}
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ label, colors, children }: { label: string; colors: typeof LIGHT; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, { color: colors.text, flex: 1 }]}>{label}</Text>
      {children}
    </View>
  );
}

function Button({ label, onPress, colors, danger }: { label: string; onPress: () => void; colors: typeof LIGHT; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={[styles.button, { borderColor: colors.muted }]} accessibilityRole="button">
      <Text style={[styles.body, { color: danger ? colors.danger : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title: { flex: 1, fontSize: 22, fontWeight: '700' },
  link: { fontSize: 17 },
  section: { fontSize: 12, letterSpacing: 0.8, marginTop: 28, marginBottom: 8 },
  label: { fontSize: 15, marginBottom: 8 },
  body: { fontSize: 16 },
  small: { fontSize: 13, marginTop: 4 },
  segments: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, alignSelf: 'flex-start', marginTop: 4 },
  input: { fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  trashRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12 },
});
