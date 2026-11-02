import { syntaxTree } from '@codemirror/language';
import { EditorState, Facet, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { focusRangeAt, type DocAccess, type FocusRange, type FocusScope } from '@margin/core';

/**
 * Focus mode and typewriter scrolling as CodeMirror extensions, shared by
 * desktop, web and the iOS DOM component. Boundary detection is the pure
 * `focusRangeAt` from @margin/core; this file only adapts CodeMirror to it and
 * turns the result into decorations. See docs/decisions/0007-focus-mode.md.
 */

/** Active focus scope; `null` disables dimming. */
export const focusScope = Facet.define<FocusScope | null, FocusScope | null>({
  combine: (values) => values.find((v) => v !== null) ?? null,
});

export const typewriterEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** Block detection only needs a line's prefix; never copy a multi-megabyte line. */
const LINE_PREFIX = 512;

function docAccess(state: EditorState): DocAccess {
  const doc = state.doc;
  return {
    length: doc.length,
    lineCount: doc.lines,
    lineText: (l) => {
      const line = doc.line(l + 1);
      return doc.sliceString(line.from, Math.min(line.to, line.from + LINE_PREFIX));
    },
    lineStart: (l) => doc.line(l + 1).from,
    lineEnd: (l) => doc.line(l + 1).to,
    lineAt: (pos) => doc.lineAt(pos).number - 1,
    slice: (from, to) => doc.sliceString(from, to),
  };
}

/** Code blocks from the incremental syntax tree, instead of scanning fences from the top. */
function codeBlockLocator(state: EditorState) {
  const tree = syntaxTree(state);
  const doc = state.doc;
  return (l: number) => {
    const line = doc.line(l + 1);
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from, 1); node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        return { startLine: doc.lineAt(node.from).number - 1, endLine: doc.lineAt(node.to).number - 1 };
      }
    }
    return null;
  };
}

export function computeFocusRange(state: EditorState, scope: FocusScope): FocusRange {
  return focusRangeAt(docAccess(state), state.selection.main.head, scope, {
    codeBlockAt: codeBlockLocator(state),
    maxLines: 500,
    maxSentenceScan: 4000,
  });
}

const dim = Decoration.mark({ class: 'cm-focus-dim' });
// Two identical-looking marks; we alternate when the focused unit changes so the
// fade-in animation restarts for the new unit but not on every keystroke.
const activeA = Decoration.mark({ class: 'cm-focus-active cm-focus-active-a' });
const activeB = Decoration.mark({ class: 'cm-focus-active cm-focus-active-b' });

class FocusPlugin {
  decorations: DecorationSet = Decoration.none;
  private range: FocusRange | null = null;
  private flip = false;

  constructor(view: EditorView) {
    this.compute(view);
  }

  update(u: ViewUpdate): void {
    if (
      u.docChanged ||
      u.selectionSet ||
      u.viewportChanged ||
      u.startState.facet(focusScope) !== u.state.facet(focusScope) ||
      syntaxTree(u.startState) !== syntaxTree(u.state)
    ) {
      this.compute(u.view);
    }
  }

  private compute(view: EditorView): void {
    const scope = view.state.facet(focusScope);
    if (!scope) {
      this.range = null;
      this.decorations = Decoration.none;
      return;
    }
    const r = computeFocusRange(view.state, scope);
    if (!this.range || this.range.from !== r.from) this.flip = !this.flip;
    this.range = r;
    const active = this.flip ? activeA : activeB;

    // Only the visible ranges get decorations: cost is O(viewport), not O(document).
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      if (from < Math.min(to, r.from)) builder.add(from, Math.min(to, r.from), dim);
      const af = Math.max(from, r.from);
      const at = Math.min(to, r.to);
      if (af < at) builder.add(af, at, active);
      const df = Math.max(from, r.to);
      if (df < to) builder.add(df, to, dim);
    }
    this.decorations = builder.finish();
  }
}

export const focusPlugin = ViewPlugin.fromClass(FocusPlugin, { decorations: (p) => p.decorations });

/**
 * Typewriter scrolling: after every edit or keyboard selection change, measure
 * where the caret is and nudge `scrollTop` so its line sits at the vertical
 * centre. This runs in CodeMirror's measure phase and only touches scrollTop
 * when the caret is off-centre, which keeps typing cheap even in 20 MB
 * documents (dispatching a `scrollIntoView` effect per keystroke cost ~50 ms
 * there). If the caret isn't rendered (a big jump), fall back to a one-off
 * centre `scrollIntoView`. Pointer selections don't scroll while the mouse is
 * down (the page mustn't move under a drag); the caret line is re-centred
 * smoothly on mouseup instead, or instantly with prefers-reduced-motion.
 */
class TypewriterPlugin {
  private fallbackPending = false;
  private pointerPending = false;
  private readonly onMouseUp = () => {
    if (!this.pointerPending) return;
    this.pointerPending = false;
    if (this.view.state.facet(typewriterEnabled)) this.recentre(true);
  };

  constructor(private readonly view: EditorView) {
    view.dom.ownerDocument.addEventListener('mouseup', this.onMouseUp);
  }

  destroy(): void {
    this.view.dom.ownerDocument.removeEventListener('mouseup', this.onMouseUp);
  }

  update(u: ViewUpdate): void {
    if (!u.state.facet(typewriterEnabled)) return;
    // A resize (e.g. the iOS keyboard shrinking the WebView) re-centres within the visible area.
    const resized = u.geometryChanged && u.view.hasFocus;
    if (!u.selectionSet && !u.docChanged && !resized) return;
    if (u.transactions.some((tr) => tr.isUserEvent('select.pointer'))) {
      this.pointerPending = true;
      return;
    }
    this.recentre();
  }

  recentre(smooth = false): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const head = view.state.selection.main.head;
        const caret = view.coordsAtPos(head, -1) ?? view.coordsAtPos(head, 1);
        if (!caret) return null;
        const box = view.scrollDOM.getBoundingClientRect();
        return (caret.top + caret.bottom) / 2 - (box.top + box.height / 2);
      },
      write: (delta, view) => {
        if (delta === null) {
          if (this.fallbackPending) return;
          this.fallbackPending = true;
          setTimeout(() => {
            this.fallbackPending = false;
            if (!view.state.facet(typewriterEnabled)) return;
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
          }, 0);
          return;
        }
        if (Math.abs(delta) <= 1) return;
        const reduce =
          typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        if (smooth && !reduce) {
          view.scrollDOM.scrollTo({ top: view.scrollDOM.scrollTop + delta, behavior: 'smooth' });
        } else {
          view.scrollDOM.scrollTop += delta;
        }
      },
    });
  }
}

export const typewriterScroll = ViewPlugin.fromClass(TypewriterPlugin);

export const focusTheme = EditorView.theme({
  '.cm-focus-dim': { opacity: 'var(--margin-dim-opacity)' },
  '.cm-focus-active-a': { animation: 'margin-focus-in-a 160ms ease-out' },
  '.cm-focus-active-b': { animation: 'margin-focus-in-b 160ms ease-out' },
  '@keyframes margin-focus-in-a': { from: { opacity: 'var(--margin-dim-opacity)' }, to: { opacity: '1' } },
  '@keyframes margin-focus-in-b': { from: { opacity: 'var(--margin-dim-opacity)' }, to: { opacity: '1' } },
  // Entering focus mode fades the rest of the text out instead of snapping.
  '&.cm-focus-entering .cm-focus-dim': { animation: 'margin-dim-in 220ms ease-out' },
  '@keyframes margin-dim-in': { from: { opacity: '1' }, to: { opacity: 'var(--margin-dim-opacity)' } },
  // Room to centre the first and last lines.
  '&.cm-typewriter .cm-content': { paddingTop: '50vh', paddingBottom: '50vh' },
  // Cursor-only: no scrollbar in focus mode.
  '&.cm-focus-mode .cm-scroller': { scrollbarWidth: 'none' },
  '&.cm-focus-mode .cm-scroller::-webkit-scrollbar': { display: 'none' },
});

export function focusExtensions(): Extension {
  return [focusPlugin, typewriterScroll, focusTheme];
}
