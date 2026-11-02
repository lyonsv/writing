import type { ReactNode } from 'react';
import { View } from 'react-native';

/**
 * Native (iOS) fallback: no drag-and-drop. A long press on the row (handled by
 * the row's own Pressable in Sidebar.tsx) opens its actions, including
 * "Move to…" (a folder picker). The web version lives in dnd.web.tsx.
 */
export interface RowShellProps {
  path: string;
  isFolder: boolean;
  testID: string;
  onContextMenu: () => void;
  onDropPath: (dragged: string) => void;
  children: ReactNode;
}

export function RowShell({ testID, children }: RowShellProps) {
  return <View testID={testID}>{children}</View>;
}

export function DropArea({ children }: { onDropPath: (dragged: string) => void; children: ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
