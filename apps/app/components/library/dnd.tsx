import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

/**
 * Native (iOS) fallback: no drag-and-drop. A long press opens the row's
 * actions (rename lets you type a different folder, see ADR 0009); moving by
 * drag is web/desktop only. The web version lives in dnd.web.tsx.
 */
export interface RowShellProps {
  path: string;
  isFolder: boolean;
  testID: string;
  onContextMenu: () => void;
  onDropPath: (dragged: string) => void;
  children: ReactNode;
}

export function RowShell({ testID, onContextMenu, children }: RowShellProps) {
  return (
    <Pressable testID={testID} onLongPress={onContextMenu} delayLongPress={400}>
      {children}
    </Pressable>
  );
}

export function DropArea({ children }: { onDropPath: (dragged: string) => void; children: ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
