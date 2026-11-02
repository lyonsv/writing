'use dom';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { FLUSH_EVENT, type FocusScope } from '@margin/core';
import type { DOMProps } from 'expo/dom';
import { useEffect, useRef, type CSSProperties } from 'react';

import { focusExtensions, focusScope as focusScopeFacet, typewriterEnabled } from './focus';
import { fontFaceCss } from './fonts';
import { EDITOR_CSS_VARS, marginHighlight, marginTheme } from './theme';

export interface ExternalContent {
  text: string;
  /** Changes whenever new external content should be considered. */
  token: string;
}

/** Commands the editor can request (keyboard shortcuts when there is no app menu). */
export type EditorCommand = 'toggle-focus' | 'toggle-typewriter' | 'scope-sentence' | 'scope-paragraph' | 'scope-off';

export interface MarkdownEditorProps {
  /** Text shown at mount. Later changes are ignored; remount (via `key`) to load another document. */
  initialValue: string;
  /**
   * Called with the full text, debounced while typing and flushed immediately on
   * blur, window blur, page hide, unload and the `FLUSH_EVENT` window event.
   * Must be async: in a native WebView this crosses the DOM-component bridge.
   */
  onChange: (text: string) => Promise<void>;
  /**
   * Content changed outside the app. Applied only if the editor has no
   * unflushed edits; otherwise the edits are flushed instead (and the save
   * pipeline turns them into a conflict copy). The outcome is reported via
   * `onExternalResult`.
   */
  external?: ExternalContent | null;
  onExternalResult?: (token: string, applied: boolean) => Promise<void>;
  /** Show the text but refuse edits (e.g. a non-UTF-8 file). Read at mount. */
  readOnly?: boolean;
  /** Focus mode on: hides the scrollbar (cursor-only chrome). */
  focusMode?: boolean;
  /** What to keep undimmed; `null` = no dimming. */
  focusScope?: FocusScope | null;
  /** Keep the caret line vertically centred. */
  typewriter?: boolean;
  /**
   * Keyboard shortcuts handled inside the editor. Not bound in the desktop
   * shell, where the application menu owns the same accelerators.
   */
  onCommand?: (command: EditorCommand) => Promise<void>;
  /** Debounce interval in ms. */
  debounceMs?: number;
  dom?: DOMProps;
}

const STYLE_ID = 'margin-editor-vars';

/** Marks transactions that load external content, so they aren't echoed back as edits. */
const externalLoad = Annotation.define<boolean>();

function ensureGlobalStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${fontFaceCss()}\n${EDITOR_CSS_VARS}`;
  document.head.appendChild(style);
}

function focusConfig(focusMode: boolean, scope: FocusScope | null): Extension {
  return [focusScopeFacet.of(scope), focusMode ? EditorView.editorAttributes.of({ class: 'cm-focus-mode' }) : []];
}

function typewriterConfig(on: boolean): Extension {
  return on ? [typewriterEnabled.of(true), EditorView.editorAttributes.of({ class: 'cm-typewriter' })] : [];
}

/** True when running inside the Electron shell (preload bridge present). */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && 'marginDesktop' in window;
}

export default function MarkdownEditor({
  initialValue,
  onChange,
  external,
  onExternalResult,
  readOnly = false,
  focusMode = false,
  focusScope = null,
  typewriter = false,
  onCommand,
  debounceMs = 300,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pendingRef = useRef<string | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onExternalResultRef = useRef(onExternalResult);
  onExternalResultRef.current = onExternalResult;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const compartments = useRef({ focus: new Compartment(), typewriter: new Compartment(), entering: new Compartment() });
  const initialConfig = useRef({ focusMode, focusScope, typewriter, readOnly });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureGlobalStyles();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const text = pendingRef.current;
      if (text === null) return;
      pendingRef.current = null;
      // Called synchronously so a flush handler can await the resulting save.
      void onChangeRef.current(text);
    };
    flushRef.current = flush;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          marginTheme,
          marginHighlight,
          placeholder('Start writing…'),
          EditorView.contentAttributes.of({
            'aria-label': 'Document',
            spellcheck: 'true',
            autocorrect: 'on',
            autocapitalize: 'sentences',
          }),
          EditorState.readOnly.of(initialConfig.current.readOnly),
          focusExtensions(),
          compartments.current.focus.of(focusConfig(initialConfig.current.focusMode, initialConfig.current.focusScope)),
          compartments.current.typewriter.of(typewriterConfig(initialConfig.current.typewriter)),
          compartments.current.entering.of([]),
          isDesktopShell()
            ? []
            : keymap.of(
                (
                  [
                    ['Mod-Shift-f', 'toggle-focus'],
                    ['Mod-Alt-t', 'toggle-typewriter'],
                    ['Mod-Alt-1', 'scope-sentence'],
                    ['Mod-Alt-2', 'scope-paragraph'],
                    ['Mod-Alt-0', 'scope-off'],
                  ] as const
                ).map(([key, command]) => ({
                  key,
                  preventDefault: true,
                  run: () => {
                    void onCommandRef.current?.(command);
                    return true;
                  },
                })),
              ),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.every((tr) => tr.annotation(externalLoad))) return;
            pendingRef.current = update.state.doc.toString();
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(flush, debounceMs);
          }),
          EditorView.domEventHandlers({ blur: () => flush() }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener(FLUSH_EVENT, flush);
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener(FLUSH_EVENT, flush);
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
      viewRef.current = null;
      view.destroy();
    };
    // initialValue is intentionally read once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounceMs]);

  // Focus / typewriter settings changes reconfigure compartments in place.
  const prevScope = useRef(focusScope);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const effects = [compartments.current.focus.reconfigure(focusConfig(focusMode, focusScope))];
    let enteringTimer: ReturnType<typeof setTimeout> | undefined;
    if (prevScope.current === null && focusScope !== null) {
      // Fade the surrounding text out when focus mode turns on.
      effects.push(compartments.current.entering.reconfigure(EditorView.editorAttributes.of({ class: 'cm-focus-entering' })));
      enteringTimer = setTimeout(() => {
        viewRef.current?.dispatch({ effects: compartments.current.entering.reconfigure([]) });
      }, 260);
    }
    prevScope.current = focusScope;
    view.dispatch({ effects });
    return () => clearTimeout(enteringTimer);
  }, [focusMode, focusScope]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        compartments.current.typewriter.reconfigure(typewriterConfig(typewriter)),
        ...(typewriter ? [EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' })] : []),
      ],
    });
  }, [typewriter]);

  const lastExternalToken = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!external || !view || external.token === lastExternalToken.current) return;
    lastExternalToken.current = external.token;
    if (pendingRef.current !== null) {
      // Unsaved edits win locally; push them so the save pipeline keeps both copies.
      flushRef.current();
      void onExternalResultRef.current?.(external.token, false);
      return;
    }
    if (view.state.doc.toString() !== external.text) {
      const head = Math.min(view.state.selection.main.head, external.text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: external.text },
        selection: EditorSelection.cursor(head),
        annotations: [externalLoad.of(true)],
      });
    }
    void onExternalResultRef.current?.(external.token, true);
  }, [external]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: 'var(--margin-bg)' }}>
      {isDesktopShell() ? (
        // Hidden-inset title bar: give the window a draggable strip with no visible chrome.
        <div
          aria-hidden
          style={
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 32,
              zIndex: 1,
              WebkitAppRegion: 'drag',
            } as CSSProperties
          }
        />
      ) : null}
      <div ref={hostRef} data-testid="editor" style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
