import { FLUSH_EVENT, SaveScheduler, basename, type SaveStatus } from '@margin/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExternalContent } from '../components/editor/MarkdownEditor';
import { getDocumentBackend } from './storage/documentStore';

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; initialText: string }
  | { status: 'error'; message: string };

export interface DocumentSession {
  load: LoadState;
  /** The path currently being written; changes to a conflict copy after a conflict. */
  path: string;
  saveStatus: SaveStatus;
  /** One-line, non-blocking message (e.g. a conflict copy was created). */
  notice: string | null;
  external: ExternalContent | null;
  onChange: (text: string) => Promise<void>;
  onExternalResult: (token: string, applied: boolean) => Promise<void>;
}

/**
 * Loads one document and runs its save pipeline (docs/decisions/0006-save-pipeline.md):
 * saves are serialised and coalesced by `SaveScheduler`, retried with backoff,
 * flushed when the desktop shell closes or quits, and redirected to a conflict
 * copy if the file changed on disk underneath us.
 */
export function useDocument(initialPath: string): DocumentSession {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [path, setPath] = useState(initialPath);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [notice, setNotice] = useState<string | null>(null);
  const [external, setExternal] = useState<ExternalContent | null>(null);
  const pathRef = useRef(initialPath);
  const schedulerRef = useRef<SaveScheduler | null>(null);

  useEffect(() => {
    let cancelled = false;
    const backend = getDocumentBackend();
    pathRef.current = initialPath;
    setPath(initialPath);

    const scheduler = new SaveScheduler(
      async (text) => {
        const result = await backend.save(pathRef.current, text);
        if (result.status === 'conflict' && pathRef.current !== result.conflictPath) {
          pathRef.current = result.conflictPath;
          if (!cancelled) {
            setPath(result.conflictPath);
            setNotice(`Changed elsewhere. Your version is in “${basename(result.conflictPath)}”.`);
          }
          // Start tracking/watching the copy we now write to.
          await backend.open(result.conflictPath);
        }
      },
      {
        onStatus: (status, error) => {
          if (status === 'error') console.error(`Margin: failed to save ${pathRef.current}`, error);
          // Keep showing "Not saved" through retries until a save actually succeeds.
          if (!cancelled) setSaveStatus((prev) => (prev === 'error' && status === 'saving' ? prev : status));
        },
      },
    );
    schedulerRef.current = scheduler;

    backend
      .open(initialPath)
      .then((doc) => {
        if (!cancelled) setLoad({ status: 'ready', initialText: doc.content });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    const offExternal = backend.onExternalChange?.((change) => {
      if (change.path !== pathRef.current) return;
      // With saves outstanding, let the save pipeline detect the conflict instead.
      if (scheduler.dirty) return;
      setExternal({ text: change.content, token: change.token });
    });

    const offFlush = backend.onFlushRequest?.(async () => {
      // The editor reacts synchronously by calling onChange with any pending text.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(FLUSH_EVENT));
      await scheduler.flush();
      if (!scheduler.dirty) return { clean: true };
      return { clean: false, path: pathRef.current, unsavedText: scheduler.latestText ?? undefined };
    });

    return () => {
      cancelled = true;
      offExternal?.();
      offFlush?.();
      void scheduler.flush().finally(() => scheduler.dispose());
    };
  }, [initialPath]);

  const onChange = useCallback(async (text: string) => {
    schedulerRef.current?.submit(text);
  }, []);

  const onExternalResult = useCallback(async (token: string, applied: boolean) => {
    if (!applied) return;
    const backend = getDocumentBackend();
    await backend.acknowledgeExternal?.(pathRef.current, token);
  }, []);

  return { load, path, saveStatus, notice, external, onChange, onExternalResult };
}
