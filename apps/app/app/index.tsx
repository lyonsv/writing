import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import MarkdownEditor from '../components/editor/MarkdownEditor';
import { useDocument } from '../src/useDocument';

/** M1: a single document. The library arrives in M3. */
const DEFAULT_DOCUMENT = 'Untitled.md';

export default function EditorScreen() {
  const dark = useColorScheme() === 'dark';
  const doc = useDocument(DEFAULT_DOCUMENT);
  const background = dark ? '#1b1b1c' : '#fbfbfa';
  const muted = dark ? '#8a8a86' : '#8a8a86';

  // Status line is empty while everything is saved: no chrome unless something needs attention.
  const status = doc.saveStatus === 'error' ? 'Not saved — retrying' : doc.notice;

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      {doc.load.status === 'ready' ? (
        <MarkdownEditor
          initialValue={doc.load.initialText}
          onChange={doc.onChange}
          external={doc.external}
          onExternalResult={doc.onExternalResult}
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
