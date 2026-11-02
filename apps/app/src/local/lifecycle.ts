/**
 * The workspace registers how to flush the editor and the open document's saves
 * (`useWorkspace().flush`); sync (before each run) and app lifecycle events
 * (iOS background, web `pagehide`/`visibilitychange`) call it. Platform-neutral.
 */
let flusher: () => Promise<boolean> = async () => true;

export function setWorkspaceFlush(fn: () => Promise<boolean>): () => void {
  flusher = fn;
  return () => {
    if (flusher === fn) flusher = async () => true;
  };
}

export function flushWorkspace(): Promise<boolean> {
  return flusher();
}
