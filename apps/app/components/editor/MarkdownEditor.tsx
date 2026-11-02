'use dom';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { FLUSH_EVENT, FOCUS_EDITOR_EVENT, type FocusScope } from '@margin/core';
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
export type EditorCommand =
  | 'toggle-focus'
  | 'toggle-typewriter'
  | 'scope-sentence'
  | 'scope-paragraph'
  | 'scope-off'
  | 'toggle-sidebar'
  | 'quick-open'
  | 'new-document';

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
  /**
   * iOS: `@font-face` CSS with the font inlined as data: URIs (built natively
   * from the bundled assets; ADR 0016). Without it the woff2 files are loaded
   * by URL, which works on web/Electron but not reliably inside the WebView.
   */
  fontCss?: string;
  /** Reports whether IBM Plex Mono actually loaded (diagnostics). */
  onFontStatus?: (status: string) => Promise<void>;
  /** Text size multiplier (iOS Dynamic Type), clamped to 0.8–1.6. */
  fontScale?: number;
  /** Changing this asks the editor to flush now; it answers with `onFlushed(id)` after its `onChange`. */
  flushRequest?: number;
  onFlushed?: (id: number) => Promise<void>;
  /** Changing this blurs the editor (dismisses the iOS keyboard). */
  blurRequest?: number;
  /** Changing this focuses the editor. */
  focusRequest?: number;
  dom?: DOMProps;
}

const STYLE_ID = 'margin-editor-vars';

/** Marks transactions that load external content, so they aren't echoed back as edits. */
const externalLoad = Annotation.define<boolean>();

function ensureGlobalStyles(fontCss: string | undefined): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${fontCss ?? fontFaceCss()}\n${EDITOR_CSS_VARS}${isNativeWebView() ? NATIVE_CSS : ''}`;
  document.head.appendChild(style);
}

/** Inside the iOS WebView the page itself must never scroll; CodeMirror's scroller does. */
const NATIVE_CSS = `
html, body { overflow: hidden; overscroll-behavior: none; -webkit-text-size-adjust: 100%; }
#root { height: 100%; }
`;

/** True inside an Expo DOM component on iOS (a WKWebView with the RN bridge). */
function isNativeWebView(): boolean {
  return typeof window !== 'undefined' && 'ReactNativeWebView' in window;
}

function focusConfig(focusMode: boolean, scope: FocusScope | null): Extension {
  return [focusScopeFacet.of(scope), focusMode ? EditorView.editorAttributes.of({ class: 'cm-focus-mode' }) : []];
}

function typewriterConfig(on: boolean): Extension {
  return on ? [typewriterEnabled.of(true), EditorView.editorAttributes.of({ class: 'cm-typewriter' })] : [];
}

/**
 * Saves serialise the whole document (toString + IPC copy), so big documents
 * save less often while typing; blur, close and quit still flush immediately.
 */
function adaptiveDebounce(length: number, base: number): number {
  if (length >= 5_000_000) return Math.max(base, 2000);
  if (length >= 1_000_000) return Math.max(base, 1000);
  return base;
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
  fontCss,
  onFontStatus,
  fontScale,
  flushRequest,
  onFlushed,
  blurRequest,
  focusRequest,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Unsaved edits exist. The text itself is only materialised (doc.toString) when flushing. */
  const dirtyRef = useRef(false);
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
    ensureGlobalStyles(fontCss);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const current = viewRef.current;
      if (!dirtyRef.current || !current) return;
      dirtyRef.current = false;
      // Called synchronously so a flush handler can await the resulting save.
      void onChangeRef.current(current.state.doc.toString());
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
                    ['Mod-\\', 'toggle-sidebar'],
                    ['Mod-p', 'quick-open'],
                    ['Mod-n', 'new-document'],
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
            dirtyRef.current = true;
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(flush, adaptiveDebounce(update.state.doc.length, debounceMs));
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
    // iOS: the keyboard shrinks the WebView. Undo any page scroll WebKit did to
    // reveal the caret, and keep the caret visible (typewriter mode re-centres
    // itself on the resize, see focus.ts).
    const onResize = () => {
      if (!isNativeWebView()) return;
      window.scrollTo(0, 0);
      if (view.hasFocus && !view.state.facet(typewriterEnabled)) {
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) });
      }
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    const takeFocus = () => view.focus();
    window.addEventListener(FOCUS_EDITOR_EVENT, takeFocus);
    window.addEventListener(FLUSH_EVENT, flush);
    window.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener(FOCUS_EDITOR_EVENT, takeFocus);
      window.removeEventListener(FLUSH_EVENT, flush);
      window.removeEventListener('blur', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
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

  // Font check: report whether the writing font really loaded (iOS diagnostics).
  const onFontStatusRef = useRef(onFontStatus);
  onFontStatusRef.current = onFontStatus;
  useEffect(() => {
    if (!onFontStatusRef.current || typeof document === 'undefined' || !document.fonts) return;
    let live = true;
    void document.fonts
      .load("18px 'IBM Plex Mono'")
      .then((faces) => {
        if (!live) return;
        const ok = faces.length > 0 && document.fonts.check("18px 'IBM Plex Mono'");
        void onFontStatusRef.current?.(ok ? `IBM Plex Mono loaded (${fontCss ? 'inline' : 'url'})` : 'IBM Plex Mono NOT loaded (fallback font)');
      })
      .catch((e: unknown) => live && void onFontStatusRef.current?.(`IBM Plex Mono failed: ${String(e)}`));
    return () => {
      live = false;
    };
  }, [fontCss]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const scale = Math.min(1.6, Math.max(0.8, fontScale ?? 1));
    document.documentElement.style.setProperty('--margin-font-scale', String(scale));
  }, [fontScale]);

  // Flush on request from the native side (app going to the background, switching documents).
  const onFlushedRef = useRef(onFlushed);
  onFlushedRef.current = onFlushed;
  useEffect(() => {
    if (flushRequest === undefined || flushRequest === 0) return;
    flushRef.current();
    void onFlushedRef.current?.(flushRequest);
  }, [flushRequest]);

  useEffect(() => {
    if (blurRequest) {
      flushRef.current();
      viewRef.current?.contentDOM.blur();
    }
  }, [blurRequest]);

  useEffect(() => {
    if (focusRequest) viewRef.current?.focus();
  }, [focusRequest]);

  const lastExternalToken = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!external || !view || external.token === lastExternalToken.current) return;
    lastExternalToken.current = external.token;
    if (dirtyRef.current) {
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
