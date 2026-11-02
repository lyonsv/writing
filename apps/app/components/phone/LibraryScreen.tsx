import { allDocuments, buildTree, canMoveInto, movedPath, type TreeNode } from '@margin/core';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QuickOpen } from '../library/QuickOpen';
import { Sidebar } from '../library/Sidebar';
import { DARK, LIGHT } from '../../src/native/palette';
import { syncLabel, useSyncStatus } from '../../src/useSyncStatus';
import { useShared } from '../../src/WorkspaceContext';
import { usePhone } from './context';

/**
 * Phone library (iOS and the web app on a phone): the desktop sidebar in phone mode (full width, long-press for
 * actions, "Move to…"), quick open as search, pull to sync. Opening a document
 * pushes the editor. On launch the last document opens straight away. ADR 0016.
 */
let resumedThisLaunch = false;

export function LibraryScreen() {
  const { nav, services } = usePhone();
  const insets = useSafeAreaInsets();
  const colors = useColorScheme() === 'dark' ? DARK : LIGHT;
  const { settings, update, ws } = useShared();
  const syncStatus = useSyncStatus();
  const [searching, setSearching] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(ws.entries, settings.librarySort), [ws.entries, settings.librarySort]);
  const documents = useMemo(() => allDocuments(tree), [tree]);

  useEffect(() => {
    if (nav.searchRequest) setSearching(true);
  }, [nav.searchRequest]);

  // Resume writing: once per app launch, when the first document is open, show it.
  // (Module-level: on the web this screen remounts every time you come back to it.)
  useEffect(() => {
    if (resumedThisLaunch || !ws.session) return;
    resumedThisLaunch = true;
    nav.openEditor();
  }, [ws.session, nav]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await ws.refresh();
      await services.sync?.syncNow();
      await ws.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const open = async (path: string) => {
    setError(null);
    if (await ws.openDocument(path)) nav.openEditor();
    else setError('The open document couldn’t be saved, so it’s still open. Try again in a moment.');
  };

  const folders = useMemo(() => {
    const out: string[] = [''];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) if (n.kind === 'folder') {
        out.push(n.path);
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const label = syncLabel(syncStatus);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <StatusBar style="auto" hidden={false} />
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
          Library
        </Text>
        {Platform.OS === 'web' && services.sync ? (
          // react-native-web has no pull-to-refresh (RefreshControl), so the web app gets a button.
          <Pressable onPress={() => void refresh()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Sync now">
            <Text style={[styles.headerButton, { color: colors.muted }]}>{refreshing ? 'Syncing…' : 'Sync'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setSearching(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Search documents">
          <Text style={[styles.headerButton, { color: colors.muted }]}>Search</Text>
        </Pressable>
        <Pressable onPress={() => nav.openSettings()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Settings and account">
          <Text style={[styles.headerButton, { color: colors.muted }]}>Settings</Text>
        </Pressable>
      </View>

      <Sidebar
        touch
        tree={tree}
        activePath={ws.activePath}
        truncatedAt={ws.truncated ? ws.entries.length : undefined}
        sort={settings.librarySort}
        colors={colors}
        onSort={(librarySort) => void update({ librarySort })}
        onOpen={(path) => void open(path)}
        onCreateDocument={async (folder) => {
          await ws.createDocument(folder);
          nav.openEditor();
        }}
        onCreateFolder={(parent) => ws.createFolder(parent)}
        onRename={ws.rename}
        onTrash={ws.trash}
        onMove={(path) => setMoving(path)}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
      />

      {error ? <Text style={[styles.footer, { color: colors.danger }]}>{error}</Text> : null}
      {label ? (
        <Text
          style={[styles.footer, { color: syncStatus?.state === 'error' ? colors.danger : colors.muted, paddingBottom: insets.bottom + 6 }]}
          numberOfLines={2}
        >
          {label}
        </Text>
      ) : (
        <View style={{ height: insets.bottom }} />
      )}

      {searching ? (
        <QuickOpen
          documents={documents}
          colors={colors}
          onClose={() => setSearching(false)}
          onOpen={(path) => {
            setSearching(false);
            void open(path);
          }}
        />
      ) : null}

      <Modal visible={moving !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setMoving(null)}>
        <View style={[styles.sheet, { backgroundColor: colors.bg }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text, fontSize: 20 }]} numberOfLines={1}>
              Move “{moving?.split('/').pop()}” to…
            </Text>
            <Pressable onPress={() => setMoving(null)} hitSlop={10} accessibilityRole="button">
              <Text style={[styles.headerButton, { color: colors.muted }]}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView>
            {folders.map((f) => {
              const ok = moving !== null && canMoveInto(moving, f);
              return (
                <Pressable
                  key={f || '(root)'}
                  disabled={!ok}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !ok }}
                  onPress={() => {
                    const from = moving!;
                    setMoving(null);
                    void ws.rename(from, movedPath(from, f)).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                  style={styles.folderRow}
                >
                  <Text style={{ fontSize: 17, color: ok ? colors.text : colors.muted, paddingLeft: f ? 16 * f.split('/').length : 0 }}>
                    {f ? f.split('/').pop() : 'Library (top level)'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 18 },
  title: { flex: 1, fontSize: 28, fontWeight: '700' },
  headerButton: { fontSize: 17 },
  footer: { fontSize: 13, paddingHorizontal: 20, paddingTop: 6 },
  sheet: { flex: 1, paddingTop: 8 },
  folderRow: { paddingHorizontal: 20, paddingVertical: 14 },
});
