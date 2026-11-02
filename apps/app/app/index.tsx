import {
  FOCUS_EDITOR_EVENT,
  allDocuments,
  buildTree,
  effectiveFocusScope,
  type AppCommand,
} from '@margin/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import MarkdownEditor, { type EditorCommand } from '../components/editor/MarkdownEditor';
import { QuickOpen } from '../components/library/QuickOpen';
import { Sidebar, type SidebarColors } from '../components/library/Sidebar';
import { getDesktopBridge, getLibraryBackend } from '../src/storage/documentStore';
import { useSettings } from '../src/useSettings';
import { useWorkspace } from '../src/useWorkspace';

const LIGHT: SidebarColors = { background: '#f3f3f1', text: '#1f1f1f', muted: '#8a8a86', active: '#e3e3df', danger: '#c2410c' };
const DARK: SidebarColors = { background: '#161617', text: '#d9d9d6', muted: '#77776f', active: '#2a2a2c', danger: '#f97316' };

export default function EditorScreen() {
  const dark = useColorScheme() === 'dark';
  const { settings, loaded, update, toggleFocus, toggleSidebar } = useSettings();
  const ws = useWorkspace(settings, loaded, update);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const background = dark ? '#1b1b1c' : '#fbfbfa';
  const colors = dark ? DARK : LIGHT;
  const desktop = getDesktopBridge() !== undefined;
  const library = getLibraryBackend();

  const tree = useMemo(() => buildTree(ws.entries, settings.librarySort), [ws.entries, settings.librarySort]);
  const documents = useMemo(() => allDocuments(tree), [tree]);
  const sidebarVisible = settings.sidebar && !settings.focusMode;

  const closeQuickOpen = useCallback(() => {
    setQuickOpenVisible(false);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(FOCUS_EDITOR_EVENT));
  }, []);

  const runAppCommand = useCallback(
    async (command: AppCommand | 'toggle-sidebar') => {
      switch (command) {
        case 'quick-open':
          return setQuickOpenVisible((v) => !v);
        case 'new-document':
          return void (await ws.createDocument());
        case 'new-folder': {
          if (!sidebarVisible) await update({ focusMode: false, sidebar: true });
          return setRenameRequest(await ws.createFolder(''));
        }
        case 'toggle-sidebar':
          return toggleSidebar();
      }
    },
    [ws, sidebarVisible, update, toggleSidebar],
  );

  useEffect(() => library.onCommand?.((c) => void runAppCommand(c)), [library, runAppCommand]);

  const runEditorCommand = useCallback(
    async (command: EditorCommand) => {
      switch (command) {
        case 'toggle-focus':
          return toggleFocus();
        case 'toggle-typewriter':
          return update({ typewriter: !settings.typewriter });
        case 'scope-sentence':
          return update({ focusScope: 'sentence' });
        case 'scope-paragraph':
          return update({ focusScope: 'paragraph' });
        case 'scope-off':
          return update({ focusScope: 'off' });
        default:
          return runAppCommand(command);
      }
    },
    [toggleFocus, update, settings.typewriter, runAppCommand],
  );

  // Nothing is shown while everything is saved. In focus mode only warnings appear.
  const status =
    ws.saveStatus === 'error' ? 'Not saved — retrying' : (ws.warning ?? (settings.focusMode ? null : ws.notice));

  return (
    <View
      style={[styles.root, { backgroundColor: background }]}
      testID="workspace"
      // Exposed for tests and accessibility tooling: which document is open.
      accessibilityLabel={ws.activePath ? `Editing ${ws.activePath}` : undefined}
    >
      {sidebarVisible ? (
        <Sidebar
          tree={tree}
          activePath={ws.activePath}
          sort={settings.librarySort}
          colors={colors}
          topInset={desktop ? 38 : 8}
          renameRequest={renameRequest}
          onSort={(librarySort) => void update({ librarySort })}
          onOpen={(path) => void ws.openDocument(path)}
          onCreateDocument={(folder) => ws.createDocument(folder)}
          onCreateFolder={(parent) => ws.createFolder(parent)}
          onRename={ws.rename}
          onTrash={ws.trash}
          onReveal={library.revealInFinder ? (p) => library.revealInFinder!(p) : undefined}
          showContextMenu={library.showContextMenu ? (items) => library.showContextMenu!(items) : undefined}
        />
      ) : null}
      <View style={styles.editorPane}>
        {ws.session ? (
          <MarkdownEditor
            key={ws.session.id}
            initialValue={ws.session.initialText}
            readOnly={ws.session.readOnly}
            onChange={ws.onChange}
            external={ws.external}
            onExternalResult={ws.onExternalResult}
            focusMode={settings.focusMode}
            focusScope={effectiveFocusScope(settings)}
            typewriter={settings.typewriter}
            onCommand={runEditorCommand}
            dom={{ style: { flex: 1, backgroundColor: background }, matchContents: false, scrollEnabled: false }}
          />
        ) : ws.loadError ? (
          <Text style={[styles.message, { color: colors.text }]}>{ws.loadError}</Text>
        ) : null}
        {status ? (
          <Text
            testID="save-status"
            accessibilityRole="alert"
            style={[styles.status, { color: ws.saveStatus === 'error' || ws.warning ? colors.danger : colors.muted }]}
          >
            {status}
          </Text>
        ) : null}
      </View>
      {quickOpenVisible ? (
        <QuickOpen
          documents={documents}
          colors={colors}
          onClose={closeQuickOpen}
          onOpen={(path) => {
            closeQuickOpen();
            void ws.openDocument(path);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  editorPane: { flex: 1 },
  message: { margin: 24, fontFamily: 'monospace' },
  status: { position: 'absolute', right: 16, bottom: 12, fontSize: 12, opacity: 0.9 },
});
