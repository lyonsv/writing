import {
  ancestorsOf,
  canMoveInto,
  displayName,
  flattenTree,
  movedPath,
  renamedPath,
  validateName,
  type ContextMenuItem,
  type LibrarySort,
  type TreeNode,
} from '@margin/core';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DropArea, RowShell } from './dnd';

export interface SidebarColors {
  background: string;
  text: string;
  muted: string;
  active: string;
  danger: string;
}

export interface SidebarProps {
  tree: TreeNode[];
  activePath: string | null;
  sort: LibrarySort;
  colors: SidebarColors;
  /** Extra top padding (e.g. clear of the macOS traffic lights). */
  topInset?: number;
  /** Path to put into inline-rename mode (e.g. a just-created folder). */
  renameRequest?: string | null;
  onSort: (sort: LibrarySort) => void;
  onOpen: (path: string) => void;
  onCreateDocument: (folder: string) => Promise<unknown>;
  onCreateFolder: (parent: string) => Promise<string>;
  onRename: (from: string, to: string) => Promise<void>;
  onTrash: (path: string) => Promise<void>;
  onReveal?: (path: string) => Promise<void>;
  /** Native context menu if available; null falls back to the in-app menu. */
  showContextMenu?: (items: ContextMenuItem[]) => Promise<string | null>;
}

const KEEP_FOCUS_ON_SUBMIT = { submitBehavior: 'submit', blurOnSubmit: false } as Record<string, unknown>;

type Action = 'open' | 'rename' | 'reveal' | 'trash' | 'new-document' | 'new-folder';

/**
 * The library sidebar, in React Native primitives so it can run on iOS (M6).
 * Only drag-and-drop and right-click are web-specific (./dnd.web.tsx).
 * See docs/decisions/0009-library-ui.md.
 */
export function Sidebar(props: SidebarProps) {
  const { tree, activePath, colors } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ path: string; kind: 'document' | 'folder'; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ node: TreeNode; items: ContextMenuItem[] } | null>(null);

  // Keep the open document visible.
  useEffect(() => {
    if (!activePath) return;
    const need = ancestorsOf(activePath);
    setExpanded((prev) => (need.every((p) => prev.has(p)) ? prev : new Set([...prev, ...need])));
  }, [activePath]);

  useEffect(() => {
    if (props.renameRequest) {
      const name = props.renameRequest.split('/').pop()!;
      setRenaming({ path: props.renameRequest, kind: 'folder', value: name });
      setExpanded((prev) => new Set([...prev, ...ancestorsOf(props.renameRequest!)]));
    }
  }, [props.renameRequest]);

  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': \w*Error: /, '') : String(e));
    }
  };

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const commitRename = async () => {
    if (!renaming) return;
    const current = renaming;
    const original = current.kind === 'document' ? displayName(current.path) : current.path.split('/').pop()!;
    if (current.value === original) return setRenaming(null);
    const problem = validateName(current.value);
    if (problem) return setError(problem);
    setRenaming(null);
    await run(() => props.onRename(current.path, renamedPath(current.path, current.value, current.kind)));
  };

  const move = (dragged: string, folder: string) => {
    if (!canMoveInto(dragged, folder)) return;
    void run(() => props.onRename(dragged, movedPath(dragged, folder)));
  };

  const actionsFor = (node: TreeNode): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (node.kind === 'folder') {
      items.push({ id: 'new-document', label: 'New Document Here' }, { id: 'new-folder', label: 'New Folder Here' });
    } else {
      items.push({ id: 'open', label: 'Open' });
    }
    items.push({ id: 'rename', label: 'Rename…' });
    if (props.onReveal) items.push({ id: 'reveal', label: 'Reveal in Finder' });
    items.push({ type: 'separator' }, { id: 'trash', label: props.onReveal ? 'Move to Trash' : 'Delete' });
    return items;
  };

  const perform = async (node: TreeNode, action: Action) => {
    switch (action) {
      case 'open':
        return props.onOpen(node.path);
      case 'rename':
        return setRenaming({
          path: node.path,
          kind: node.kind,
          value: node.kind === 'document' ? displayName(node.path) : node.name,
        });
      case 'reveal':
        return run(() => props.onReveal!(node.path));
      case 'trash':
        return run(() => props.onTrash(node.path));
      case 'new-document':
        setExpanded((prev) => new Set([...prev, node.path]));
        return run(() => props.onCreateDocument(node.path));
      case 'new-folder':
        setExpanded((prev) => new Set([...prev, node.path]));
        return run(async () => {
          const created = await props.onCreateFolder(node.path);
          setRenaming({ path: created, kind: 'folder', value: created.split('/').pop()! });
        });
    }
  };

  const openMenu = async (node: TreeNode) => {
    const items = actionsFor(node);
    if (props.showContextMenu) {
      const chosen = await props.showContextMenu(items);
      if (chosen) await perform(node, chosen as Action);
    } else {
      setMenu({ node, items });
    }
  };

  return (
    <View testID="library-sidebar" style={[styles.root, { backgroundColor: colors.background, paddingTop: props.topInset ?? 0 }]}>
      <View style={styles.header}>
        <Pressable testID="library-new-document" onPress={() => void run(() => props.onCreateDocument(''))} hitSlop={6}>
          <Text style={[styles.headerButton, { color: colors.muted }]}>New</Text>
        </Pressable>
        <Pressable
          testID="library-new-folder"
          onPress={() =>
            void run(async () => {
              const created = await props.onCreateFolder('');
              setRenaming({ path: created, kind: 'folder', value: created.split('/').pop()! });
            })
          }
          hitSlop={6}
        >
          <Text style={[styles.headerButton, { color: colors.muted }]}>Folder</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          testID="library-sort"
          onPress={() => props.onSort(props.sort === 'name' ? 'modified' : 'name')}
          hitSlop={6}
          accessibilityLabel={`Sorted by ${props.sort === 'name' ? 'name' : 'date modified'}`}
        >
          <Text style={[styles.headerButton, { color: colors.muted }]}>{props.sort === 'name' ? 'A–Z' : 'Recent'}</Text>
        </Pressable>
      </View>

      <DropArea onDropPath={(dragged) => move(dragged, '')}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {rows.map(({ node, depth, expanded: isOpen }) => {
            const active = node.kind === 'document' && node.path === activePath;
            const editing = renaming?.path === node.path;
            const label = node.kind === 'document' ? displayName(node.path) : node.name;
            return (
              <RowShell
                key={node.path}
                path={node.path}
                isFolder={node.kind === 'folder'}
                testID={`library-row:${node.path}`}
                onContextMenu={() => void openMenu(node)}
                onDropPath={(dragged) => move(dragged, node.path)}
              >
                <Pressable
                  onPress={() => (node.kind === 'folder' ? toggle(node.path) : props.onOpen(node.path))}
                  style={[styles.row, { paddingLeft: 12 + depth * 14 }, active && { backgroundColor: colors.active }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, expanded: node.kind === 'folder' ? isOpen : undefined }}
                >
                  <Text style={[styles.disclosure, { color: colors.muted }]}>
                    {node.kind === 'folder' ? (isOpen ? '▾' : '▸') : ''}
                  </Text>
                  {editing ? (
                    <TextInput
                      testID="library-rename-input"
                      autoFocus
                      selectTextOnFocus
                      value={renaming.value}
                      onChangeText={(value) => setRenaming({ ...renaming, value })}
                      // Keep focus after Enter. By default react-native-web blurs a single-line input
                      // one macrotask after submit; after an invalid name that late blur ran
                      // commitRename (onBlur) on whatever had been typed since, committing a name
                      // the user hadn't confirmed and closing the field (the flaky library e2e).
                      // `blurOnSubmit` is what RNW reads; `submitBehavior` is the RN (iOS) spelling.
                      {...KEEP_FOCUS_ON_SUBMIT}
                      onSubmitEditing={() => void commitRename()}
                      onBlur={() => void commitRename()}
                      onKeyPress={(e) => {
                        if (e.nativeEvent.key === 'Escape') {
                          setRenaming(null);
                          setError(null);
                        }
                      }}
                      style={[styles.input, { color: colors.text, borderColor: colors.muted }]}
                    />
                  ) : (
                    <Text numberOfLines={1} style={[styles.label, { color: active ? colors.text : colors.text }]}>
                      {label}
                    </Text>
                  )}
                </Pressable>
              </RowShell>
            );
          })}
        </ScrollView>
      </DropArea>

      {error ? (
        <Text testID="library-error" style={[styles.error, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}

      {menu ? (
        // In-app fallback menu (browser / iOS); desktop uses the native context menu.
        <Pressable style={styles.menuBackdrop} onPress={() => setMenu(null)}>
          <View style={[styles.menu, { backgroundColor: colors.background, borderColor: colors.muted }]}>
            {menu.items.map((item, i) =>
              'type' in item ? (
                <View key={`sep${i}`} style={[styles.separator, { backgroundColor: colors.muted }]} />
              ) : (
                <Pressable
                  key={item.id}
                  testID={`library-action:${item.id}`}
                  onPress={() => {
                    const node = menu.node;
                    setMenu(null);
                    void perform(node, item.id as Action);
                  }}
                  style={styles.menuItem}
                >
                  <Text style={{ color: item.id === 'trash' ? colors.danger : colors.text, fontSize: 13 }}>{item.label}</Text>
                </Pressable>
              ),
            )}
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: 260, height: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, gap: 14 },
  headerButton: { fontSize: 12, letterSpacing: 0.2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, paddingRight: 12, borderRadius: 4, marginHorizontal: 6 },
  disclosure: { width: 14, fontSize: 10 },
  label: { flex: 1, fontSize: 13 },
  input: { flex: 1, fontSize: 13, paddingVertical: 1, paddingHorizontal: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 3 },
  error: { fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
  menuBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  menu: { minWidth: 180, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingVertical: 4 },
  menuItem: { paddingVertical: 6, paddingHorizontal: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: 4, opacity: 0.5 },
});
