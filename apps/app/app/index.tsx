import { StyleSheet, Text, View, useColorScheme } from 'react-native';

import MarkdownEditor from '../components/editor/MarkdownEditor';
import { useDocument } from '../src/useDocument';

/** M1: a single document. The library arrives in M3. */
const DEFAULT_DOCUMENT = 'Untitled.md';

export default function EditorScreen() {
  const dark = useColorScheme() === 'dark';
  const { state, save } = useDocument(DEFAULT_DOCUMENT);
  const background = dark ? '#1b1b1c' : '#fbfbfa';

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      {state.status === 'ready' ? (
        <MarkdownEditor
          key={state.path}
          initialValue={state.initialText}
          onChange={save}
          dom={{ style: { flex: 1, backgroundColor: background }, matchContents: false, scrollEnabled: false }}
        />
      ) : state.status === 'error' ? (
        <Text style={[styles.message, { color: dark ? '#d9d9d6' : '#1f1f1f' }]}>{state.message}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  message: { margin: 24, fontFamily: 'monospace' },
});
