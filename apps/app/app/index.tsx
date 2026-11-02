import { effectiveFocusScope } from '@margin/core';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import MarkdownEditor from '../components/editor/MarkdownEditor';
import { useDocument } from '../src/useDocument';
import { useSettings } from '../src/useSettings';

/** M1: a single document. The library arrives in M3. */
const DEFAULT_DOCUMENT = 'Untitled.md';

export default function EditorScreen() {
  const dark = useColorScheme() === 'dark';
  const doc = useDocument(DEFAULT_DOCUMENT);
  const { settings, runCommand } = useSettings();
  const background = dark ? '#1b1b1c' : '#fbfbfa';
  const muted = '#8a8a86';

  // Nothing is shown while everything is saved. In focus mode only the
  // "Not saved" warning may appear; informational notices are suppressed.
  const status =
    doc.saveStatus === 'error' ? 'Not saved — retrying' : settings.focusMode ? null : doc.notice;

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      {doc.load.status === 'ready' ? (
        <MarkdownEditor
          initialValue={doc.load.initialText}
          onChange={doc.onChange}
          external={doc.external}
          onExternalResult={doc.onExternalResult}
          focusMode={settings.focusMode}
          focusScope={effectiveFocusScope(settings)}
          typewriter={settings.typewriter}
          onCommand={runCommand}
          dom={{ style: { flex: 1, backgroundColor: background }, matchContents: false, scrollEnabled: false }}
        />
      ) : doc.load.status === 'error' ? (
        <Text style={[styles.message, { color: dark ? '#d9d9d6' : '#1f1f1f' }]}>{doc.load.message}</Text>
      ) : null}
      {status ? (
        <Text
          testID="save-status"
          accessibilityRole="alert"
          style={[styles.status, { color: doc.saveStatus === 'error' ? '#c2410c' : muted }]}
        >
          {status}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  message: { margin: 24, fontFamily: 'monospace' },
  status: { position: 'absolute', right: 16, bottom: 12, fontSize: 12, opacity: 0.9 },
});
