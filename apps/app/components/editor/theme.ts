import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Colours are CSS custom properties so light/dark follows the OS via
 * `prefers-color-scheme` without reconfiguring the editor.
 */
export const EDITOR_CSS_VARS = `
:root {
  color-scheme: light dark;
  --margin-bg: #fbfbfa;
  --margin-fg: #1f1f1f;
  --margin-muted: #a3a3a0;
  --margin-accent: #1a8fc7;
  --margin-caret: #1a8fc7;
  --margin-selection: rgba(26, 143, 199, 0.18);
  --margin-code-bg: rgba(0, 0, 0, 0.04);
  --margin-dim-opacity: 0.28;
}
@media (prefers-color-scheme: dark) {
  :root {
    --margin-bg: #1b1b1c;
    --margin-fg: #d9d9d6;
    --margin-muted: #6b6b68;
    --margin-accent: #4fb3e6;
    --margin-caret: #4fb3e6;
    --margin-selection: rgba(79, 179, 230, 0.25);
    --margin-code-bg: rgba(255, 255, 255, 0.05);
    --margin-dim-opacity: 0.32;
  }
}
html, body { margin: 0; padding: 0; height: 100%; background: var(--margin-bg); }
`;

export const FONT_STACK = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace";

export const marginTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--margin-fg)',
    backgroundColor: 'var(--margin-bg)',
    fontSize: '18px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: FONT_STACK,
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    // A centred measure of ~68 characters. `ch` resolves against Plex Mono.
    maxWidth: '68ch',
    width: '100%',
    margin: '0 auto',
    padding: '12vh 0 40vh',
    boxSizing: 'border-box',
    caretColor: 'var(--margin-caret)',
    fontVariantLigatures: 'none',
  },
  '.cm-line': { padding: '0 24px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--margin-caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--margin-selection)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--margin-muted)', fontStyle: 'normal' },
});

/**
 * Subtle markdown styling: content keeps the text colour and size; syntax
 * markers (`#`, `*`, `>`, `-`, backticks, link brackets) are dimmed.
 * `processingInstruction` is what @lezer/markdown assigns to those marks.
 *
 * Order matters: lang-markdown tags whole blocks with inheriting tags
 * (`Blockquote/...` → quote, `Link/...` → link), so a `>` or `[` span carries
 * both the parent class and the mark class at equal specificity. The marker
 * rule therefore comes last so it wins.
 */
export const marginHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading, fontWeight: '700' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.quote, color: 'var(--margin-fg)' },
    { tag: [t.link, t.url], color: 'var(--margin-accent)' },
    { tag: t.monospace, backgroundColor: 'var(--margin-code-bg)', borderRadius: '3px' },
    { tag: t.contentSeparator, color: 'var(--margin-muted)' },
    { tag: t.meta, color: 'var(--margin-muted)' },
    { tag: t.processingInstruction, color: 'var(--margin-muted)' },
  ]),
);
