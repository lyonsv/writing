import { useState, type DragEvent, type ReactNode } from 'react';

import type { RowShellProps } from './dnd';

/** Web/desktop: HTML5 drag-and-drop and right-click, wrapped around RN content. */
const MIME = 'application/x-margin-path';

function draggedPath(e: DragEvent): string | null {
  return e.dataTransfer.types.includes(MIME) ? e.dataTransfer.getData(MIME) || null : null;
}

export function RowShell({ path, isFolder, testID, onContextMenu, onDropPath, children }: RowShellProps) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid={testID}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, path);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!isFolder || !e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!isFolder) return;
        const dragged = draggedPath(e);
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        onDropPath(dragged);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu();
      }}
      // Flex column so the row's button stretches across the full width (clickable anywhere).
      style={{
        display: 'flex',
        flexDirection: 'column',
        outline: over ? '1px solid var(--margin-drop, #1a8fc7)' : 'none',
        borderRadius: 4,
      }}
    >
      {children}
    </div>
  );
}

/** The sidebar background: dropping here moves to the library root. */
export function DropArea({ onDropPath, children }: { onDropPath: (dragged: string) => void; children: ReactNode }) {
  return (
    <div
      data-testid="library-root-drop"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const dragged = draggedPath(e);
        if (!dragged) return;
        e.preventDefault();
        onDropPath(dragged);
      }}
    >
      {children}
    </div>
  );
}
