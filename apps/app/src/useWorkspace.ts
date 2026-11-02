import {
  FLUSH_EVENT,
  SaveScheduler,
  basename,
  childNames,
  detectLineEnding,
  dirname,
  isWithin,
  newDocumentPath,
  newFolderPath,
  rebasePath,
  withLineEnding,
  type LibraryEntry,
  type LineEnding,
  type OpenedDocument,
  type SaveStatus,
  type Settings,
} from '@margin/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExternalContent } from '../components/editor/MarkdownEditor';
import { getDocumentBackend, getLibraryBackend } from './storage/documentStore';

/** One open document and its save pipeline (docs/decisions/0006-save-pipeline.md). */
export interface Session {
  id: number;
  /** Current path; follows renames, moves and conflict copies. */
  path: string;
  initialText: string;
  readOnly: boolean;
  eol: LineEnding;
  scheduler: SaveScheduler;
  /** Set once the document has been trashed: further saves are dropped, never recreating it. */
  closed: boolean;
}

let sessionSeq = 0;

/**
 * The library listing plus the open document. Every operation that touches
 * the open document coordinates with its save pipeline:
 * - switching documents saves the current one first (and refuses to switch if it can't);
 * - renaming/moving it pauses saves, moves the file, then resumes at the new path;
 * - trashing it saves first (so the Trash has the latest text) and then never writes again.
 * See docs/decisions/0008-library-model.md.
 */
export function useWorkspace(
  settings: Settings,
  settingsLoaded: boolean,
  updateSettings: (patch: Partial<Settings>) => Promise<void>,
) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [external, setExternal] = useState<ExternalContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const entriesRef = useRef<LibraryEntry[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const updateSettingsRef = useRef(updateSettings);
  updateSettingsRef.current = updateSettings;

  /** Library operations run one at a time. */
  const serialize = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(fn, fn);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const refresh = useCallback(async () => {
    const list = await getLibraryBackend().listTree();
    entriesRef.current = list;
    setEntries(list);
    return list;
  }, []);

  const rememberPath = useCallback((s: Session) => {
    if (sessionRef.current !== s) return;
    setActivePath(s.path);
    void updateSettingsRef.current({ lastDocument: s.path });
  }, []);

  const makeSession = useCallback(
    (doc: OpenedDocument): Session => {
      const docs = getDocumentBackend();
      const s: Session = {
        id: ++sessionSeq,
        path: doc.path,
        initialText: doc.content,
        readOnly: doc.readOnly !== undefined,
        eol: detectLineEnding(doc.content),
        closed: false,
        scheduler: undefined as unknown as SaveScheduler,
      };
      s.scheduler = new SaveScheduler(
        async (text) => {
          if (s.closed) return;
          const result = await docs.save(s.path, withLineEnding(text, s.eol));
          if (result.status === 'saved' && result.path !== s.path) {
            s.path = result.path; // main followed a move we raced with
            rememberPath(s);
          }
          if (result.status === 'conflict' && s.path !== result.conflictPath) {
            s.path = result.conflictPath;
            if (sessionRef.current === s) {
              setNotice(`Changed elsewhere. Your version is in “${basename(result.conflictPath)}”.`);
            }
            rememberPath(s);
            await docs.open(result.conflictPath); // track and watch the copy we now write to
            void refresh();
          }
        },
        {
          onStatus: (status, error) => {
            if (status === 'error') console.error(`Margin: failed to save ${s.path}`, error);
            if (sessionRef.current !== s) return;
            // Keep "Not saved" up through retries until a save actually succeeds.
            setSaveStatus((prev) => (prev === 'error' && status === 'saving' ? prev : status));
          },
        },
      );
      return s;
    },
    [refresh, rememberPath],
  );

  /** Pushes the editor's pending text and waits for it to save. False if it couldn't be saved. */
  const flushCurrent = useCallback(async (): Promise<boolean> => {
    const s = sessionRef.current;
    if (!s) return true;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(FLUSH_EVENT));
    await s.scheduler.flush();
    return !s.scheduler.dirty;
  }, []);

  const activate = useCallback(
    (doc: OpenedDocument) => {
      const s = makeSession(doc);
      sessionRef.current = s;
      setSession(s);
      setSaveStatus('saved');
      setNotice(null);
      setExternal(null);
      setWarning(
        doc.readOnly === 'not-utf8' ? 'Read-only: this file isn’t UTF-8 text, so editing it here could corrupt it.' : null,
      );
      rememberPath(s);
    },
    [makeSession, rememberPath],
  );

  const openNow = useCallback(
    async (path: string): Promise<boolean> => {
      if (sessionRef.current?.path === path) return true;
      if (!(await flushCurrent())) return false; // "Not saved" stays visible; don't abandon the text
      activate(await getDocumentBackend().open(path));
      return true;
    },
    [activate, flushCurrent],
  );

  const openDocument = useCallback((path: string) => serialize(() => openNow(path)), [openNow, serialize]);

  const createDocumentNow = useCallback(
    async (folder?: string): Promise<string> => {
      const list = await refresh();
      const parent = folder ?? (sessionRef.current ? dirname(sessionRef.current.path) : '');
      for (let attempt = 0; attempt < 3; attempt++) {
        const path = newDocumentPath(parent, new Date(), childNames(list, parent));
        try {
          await getLibraryBackend().createDocument(path);
          await refresh();
          return path;
        } catch (error) {
          if ((error as { code?: string }).code !== 'exists' && !String(error).includes('exists')) throw error;
          await refresh();
        }
      }
      throw new Error('Could not create a new document');
    },
    [refresh],
  );

  const createDocument = useCallback(
    (folder?: string) =>
      serialize(async () => {
        const path = await createDocumentNow(folder);
        await openNow(path);
        return path;
      }),
    [createDocumentNow, openNow, serialize],
  );

  const createFolder = useCallback(
    (parent = '') =>
      serialize(async () => {
        const list = await refresh();
        const path = newFolderPath(parent, childNames(list, parent));
        await getLibraryBackend().createFolder(path);
        await refresh();
        return path;
      }),
    [refresh, serialize],
  );

  /** Rename or move. If it affects the open document, the editor follows without losing text. */
  const rename = useCallback(
    (from: string, to: string) =>
      serialize(async () => {
        const s = sessionRef.current;
        const next = s ? rebasePath(s.path, from, to) : null;
        if (s && next !== null) {
          await s.scheduler.exclusive(async () => {
            await getLibraryBackend().rename(from, to);
            s.path = next;
          });
          rememberPath(s);
        } else {
          await getLibraryBackend().rename(from, to);
        }
        await refresh();
      }),
    [refresh, rememberPath, serialize],
  );

  const trash = useCallback(
    (path: string) =>
      serialize(async () => {
        const s = sessionRef.current;
        const affected = s !== null && isWithin(path, s.path);
        if (s && affected) {
          await flushCurrent(); // the Trash gets the latest text
          await s.scheduler.exclusive(async () => {
            await getLibraryBackend().trash(path);
            s.closed = true;
          });
        } else {
          await getLibraryBackend().trash(path);
        }
        const list = await refresh();
        if (affected) {
          const next = pickInitial(list, undefined) ?? (await createDocumentNow(''));
          sessionRef.current = null;
          await openNow(next);
        }
      }),
    [createDocumentNow, flushCurrent, openNow, refresh, serialize],
  );

  // Library listing, live updates, menu-driven events.
  useEffect(() => {
    const lib = getLibraryBackend();
    void refresh();
    return lib.onChange?.(() => void refresh());
  }, [refresh]);

  // First document: last opened, else most recent, else a new date-named one.
  const started = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || started.current) return;
    started.current = true;
    void serialize(async () => {
      const list = await refresh();
      const target = pickInitial(list, settings.lastDocument) ?? (await createDocumentNow(''));
      await openNow(target);
    }).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, [settingsLoaded, settings.lastDocument, refresh, serialize, createDocumentNow, openNow]);

  // External edits, and the desktop close/quit flush handshake.
  useEffect(() => {
    const docs = getDocumentBackend();
    const offExternal = docs.onExternalChange?.((change) => {
      const s = sessionRef.current;
      // With saves outstanding, the save pipeline turns this into a conflict copy instead.
      if (!s || change.path !== s.path || s.scheduler.dirty) return;
      s.eol = detectLineEnding(change.content);
      setExternal({ text: change.content, token: change.token });
    });
    const offFlush = docs.onFlushRequest?.(async () => {
      const s = sessionRef.current;
      if (!s || (await flushCurrent())) return { clean: true };
      const latest = s.scheduler.latestText;
      return {
        clean: false,
        path: s.path,
        unsavedText: latest === null ? undefined : withLineEnding(latest, s.eol),
      };
    });
    return () => {
      offExternal?.();
      offFlush?.();
    };
  }, [flushCurrent]);

  const onChange = useCallback(
    async (text: string) => {
      session?.scheduler.submit(text);
    },
    [session],
  );

  const onExternalResult = useCallback(async (token: string, applied: boolean) => {
    const s = sessionRef.current;
    if (applied && s) await getDocumentBackend().acknowledgeExternal?.(s.path, token);
  }, []);

  return {
    entries,
    session,
    activePath,
    saveStatus,
    notice,
    warning,
    external,
    loadError,
    onChange,
    onExternalResult,
    openDocument,
    createDocument,
    createFolder,
    rename,
    trash,
    refresh,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

/** Last opened if it still exists, else the most recently modified document. */
export function pickInitial(entries: readonly LibraryEntry[], lastDocument: string | undefined): string | null {
  const docs = entries.filter((e) => e.kind === 'document');
  if (lastDocument && docs.some((d) => d.path === lastDocument)) return lastDocument;
  let best: (typeof docs)[number] | undefined;
  for (const d of docs) if (d.kind === 'document' && (!best || (best.kind === 'document' && d.modifiedAt > best.modifiedAt))) best = d;
  return best?.path ?? null;
}
