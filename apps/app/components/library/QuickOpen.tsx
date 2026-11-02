import { quickOpen, type DocumentNode } from '@margin/core';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { radius, space, type } from '../ui/tokens';
import type { SidebarColors } from './Sidebar';

export interface QuickOpenProps {
  documents: DocumentNode[];
  colors: SidebarColors;
  onOpen: (path: string) => void;
  onClose: () => void;
}

/**
 * ⌘P overlay: fuzzy search over document titles and paths. RN primitives only.
 * Keys: ↑/↓ (or Ctrl-P/N) move, Enter opens, Escape closes.
 */
export function QuickOpen({ documents, colors, onOpen, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const results = useMemo(() => quickOpen(documents, query, 50), [documents, query]);

  useEffect(() => setSelected(0), [query]);

  const choose = (index: number) => {
    const r = results[index];
    if (r) onOpen(r.path);
  };

  return (
    <Pressable testID="quick-open" style={styles.backdrop} onPress={onClose}>
      <Pressable style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.muted }]} onPress={() => {}}>
        <TextInput
          testID="quick-open-input"
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Open document…"
          placeholderTextColor={colors.muted}
          onSubmitEditing={() => choose(selected)}
          onKeyPress={(e) => {
            const key = e.nativeEvent.key;
            const ctrl = (e.nativeEvent as unknown as { ctrlKey?: boolean }).ctrlKey;
            if (key === 'Escape') onClose();
            else if (key === 'ArrowDown' || (ctrl && key === 'n')) {
              (e as unknown as { preventDefault?: () => void }).preventDefault?.();
              setSelected((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
            } else if (key === 'ArrowUp' || (ctrl && key === 'p')) {
              (e as unknown as { preventDefault?: () => void }).preventDefault?.();
              setSelected((i) => Math.max(i - 1, 0));
            }
          }}
          style={[styles.input, { color: colors.text }]}
        />
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {results.length === 0 ? (
            <Text style={[styles.empty, { color: colors.muted }]}>No matching documents</Text>
          ) : (
            results.map((r, i) => (
              <Pressable
                key={r.path}
                testID={`quick-open-result:${r.path}`}
                aria-selected={i === selected}
                onPress={() => choose(i)}
                style={[styles.result, i === selected && { backgroundColor: colors.active }]}
              >
                <Text numberOfLines={1} style={[type.body, { color: colors.text }]}>
                  {r.title}
                </Text>
                <Text numberOfLines={1} style={[type.small, { color: colors.muted }]}>
                  {r.path}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: '12%' },
  panel: { width: 520, maxWidth: '90%', maxHeight: '60%', borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  input: { fontSize: 16, paddingHorizontal: space.l, paddingVertical: space.m },
  list: { flexGrow: 0 },
  result: { paddingHorizontal: space.l, paddingVertical: 6 },
  empty: { paddingHorizontal: space.l, paddingVertical: space.m, ...type.small },
});
