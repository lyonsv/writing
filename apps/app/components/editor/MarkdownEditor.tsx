'use dom';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import type { DOMProps } from 'expo/dom';
import { useEffect, useRef, type CSSProperties } from 'react';

import { fontFaceCss } from './fonts';
import { EDITOR_CSS_VARS, marginHighlight, marginTheme } from './theme';

export interface MarkdownEditorProps {
  /** Text shown at mount. Later changes are ignored; remount (via `key`) to load another document. */
  initialValue: string;
  /**
   * Called with the full text, debounced while typing and flushed on blur.
   * Must be async: in a native WebView this crosses the DOM-component bridge.
   */
  onChange: (text: string) => Promise<void>;
  /** Debounce interval in ms. */
  debounceMs?: number;
  dom?: DOMProps;
}

const STYLE_ID = 'margin-editor-vars';

function ensureGlobalStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${fontFaceCss()}\n${EDITOR_CSS_VARS}`;
  document.head.appendChild(style);
}

/** True when running inside the Electron shell (preload bridge present). */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && 'marginDesktop' in window;
}

export default function MarkdownEditor({ initialValue, onChange, debounceMs = 300 }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureGlobalStyles();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string | null = null;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (pending === null) return;
      const text = pending;
      pending = null;
      void onChangeRef.current(text);
    };

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
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            pending = update.state.doc.toString();
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(flush, debounceMs);
          }),
          EditorView.domEventHandlers({ blur: () => flush() }),
        ],
      }),
    });
    view.focus();

    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
      view.destroy();
    };
    // initialValue is intentionally read once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounceMs]);

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
