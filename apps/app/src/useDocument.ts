import { useCallback, useEffect, useState } from 'react';

import { getDocumentStore } from './storage/documentStore';

export type DocumentState =
  | { status: 'loading' }
  | { status: 'ready'; path: string; initialText: string }
  | { status: 'error'; message: string };

/** Loads one document (creating it if missing) and returns a save callback. */
export function useDocument(path: string) {
  const [state, setState] = useState<DocumentState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const store = getDocumentStore();
    (async () => {
      let text = await store.read(path);
      if (text === null) {
        text = '';
        await store.write(path, text);
      }
      if (!cancelled) setState({ status: 'ready', path, initialText: text });
    })().catch((error: unknown) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(
    async (text: string) => {
      try {
        await getDocumentStore().write(path, text);
      } catch (error) {
        console.error(`Margin: failed to save ${path}`, error);
      }
    },
    [path],
  );

  return { state, save };
}
