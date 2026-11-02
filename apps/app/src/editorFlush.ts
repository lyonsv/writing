import { FLUSH_EVENT } from '@margin/core';

/**
 * Asks the open editor to hand over unsaved text now. On web/Electron the
 * editor is in the same document and listens for `FLUSH_EVENT` (synchronous).
 * On iOS it lives in a WebView: the editor screen registers a flusher that
 * round-trips through the DOM-component bridge (`flushRequest` → `onFlushed`).
 */
type Flusher = () => Promise<void>;
let flusher: Flusher | null = null;

export function setEditorFlusher(f: Flusher): () => void {
  flusher = f;
  return () => {
    if (flusher === f) flusher = null;
  };
}

export async function flushEditor(): Promise<void> {
  if (flusher) return flusher();
  const w = typeof window !== 'undefined' ? (window as { dispatchEvent?: (e: Event) => boolean }) : undefined;
  if (typeof w?.dispatchEvent === 'function' && typeof Event === 'function') w.dispatchEvent(new Event(FLUSH_EVENT));
}
