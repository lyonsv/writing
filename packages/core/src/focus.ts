/**
 * Pure focus-mode boundary detection: which sentence or markdown block
 * contains a position. Editor-agnostic (CodeMirror adapts its `Text` to
 * `DocAccess`), and bounded: work is proportional to the block/sentence
 * around the cursor (capped), never to the document size.
 * See docs/decisions/0007-focus-mode.md.
 */

export type FocusScope = 'sentence' | 'paragraph';

export interface TextRange {
  from: number;
  to: number;
}

// ------------------------------------------------------------------ sentences

/** Abbreviations after which a period never ends a sentence. */
const NEVER_ENDS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'hon', 'gen', 'col', 'capt', 'lt', 'sgt',
  'e.g', 'i.e', 'cf', 'vs', 'viz', 'approx', 'ca', 'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov',
]);

/** Abbreviations that don't end a sentence when a number follows: "No. 5", "p. 12", "Fig. 3". */
const BEFORE_NUMBER = new Set(['no', 'nos', 'p', 'pp', 'vol', 'vols', 'fig', 'figs', 'eq', 'ch', 'sec', 'para', 'art']);

/** Abbreviations that may end a sentence: they do only if the next word is capitalised. */
const MAYBE_ENDS = new Set(['etc', 'inc', 'ltd', 'co', 'corp', 'al', 'u.s', 'u.k', 'a.m', 'p.m', 'ph.d', 'b.c', 'a.d']);

const TERMINATORS = '.!?…';
const CLOSERS = '"\'”’»)]*_`';
const OPENERS = '"\'“‘«([*_`';

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
const isUpper = (ch: string | undefined) => ch !== undefined && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
const isLower = (ch: string | undefined) => ch !== undefined && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';

/** First non-space, non-opener character at or after `i`. */
function nextWordChar(text: string, i: number): string | undefined {
  let j = i;
  while (j < text.length && (isSpace(text[j]) || OPENERS.includes(text[j]!))) j++;
  return text[j];
}

/** The word (letters and internal dots) immediately before position `end`, lowercased. */
function wordBefore(text: string, end: number): string {
  let j = end;
  while (j > 0 && /[\p{L}\p{N}.]/u.test(text[j - 1]!)) j--;
  return text.slice(j, end).toLowerCase();
}

/**
 * Sentence boundary offsets in `text`: each value is the end of a sentence
 * (just after its terminator and any closing quotes/brackets/emphasis).
 */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (!TERMINATORS.includes(text[i]!)) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < text.length && TERMINATORS.includes(text[i]!)) i++;
    const run = text.slice(runStart, i);
    while (i < text.length && CLOSERS.includes(text[i]!)) i++;
    const end = i;
    // A boundary needs whitespace (or the end of the text) after it: "3.14", "a.b" are not ends.
    if (end < text.length && !isSpace(text[end])) continue;
    const next = nextWordChar(text, end);
    if (next === undefined) {
      ends.push(end);
      continue;
    }
    const ellipsis = run.includes('…') || run.includes('..');
    if (ellipsis) {
      // "Wait... what?" continues; "I see... Then he left." ends.
      if (isUpper(next)) ends.push(end);
      continue;
    }
    if (isLower(next)) continue; // "Really? yes" / "e.g. the" style continuation
    if (run === '.') {
      const word = wordBefore(text, runStart);
      if (NEVER_ENDS.has(word)) continue;
      if (word.length === 1 && isUpper(text[runStart - 1])) continue; // initials: "J. R. R. Tolkien"
      // "No. 5", "p. 12", and "5. 6" (a number then a number) don't end sentences.
      if (isDigit(next) && (BEFORE_NUMBER.has(word) || /^\p{N}*$/u.test(word))) continue;
      if ((MAYBE_ENDS.has(word) || word.includes('.')) && !isUpper(next)) continue;
    }
    ends.push(end);
  }
  return ends;
}

/**
 * The sentence containing `offset` within `text`. The range excludes the
 * whitespace between sentences. A cursor sitting right after a sentence's
 * terminator belongs to that sentence (so typing continues it); a cursor in
 * the gap before the next sentence belongs to the next one.
 */
export function sentenceRangeAt(text: string, offset: number): TextRange {
  const pos = Math.max(0, Math.min(offset, text.length));
  let start = 0;
  for (const end of sentenceEnds(text)) {
    if (pos <= end && pos >= start) return trimRange(text, start, end, pos);
    start = end;
    if (start > pos) break;
  }
  return trimRange(text, start, text.length, pos);
}

function trimRange(text: string, from: number, to: number, pos: number): TextRange {
  let a = from;
  let b = to;
  while (a < b && isSpace(text[a])) a++;
  while (b > a && isSpace(text[b - 1])) b--;
  if (pos < a) return { from: pos, to: pos }; // shouldn't happen, but never return a range not containing pos
  return { from: a, to: Math.max(b, Math.min(pos, to)) };
}

// ------------------------------------------------------------------ blocks

export type BlockKind = 'paragraph' | 'heading' | 'list-item' | 'quote' | 'code' | 'thematic-break' | 'blank';

/** Inclusive 0-based line span. */
export interface Block {
  kind: BlockKind;
  startLine: number;
  endLine: number;
}

/** Minimal read access to a document; 0-based lines. */
export interface DocAccess {
  readonly length: number;
  readonly lineCount: number;
  lineText(line: number): string;
  lineStart(line: number): number;
  lineAt(pos: number): number;
  slice(from: number, to: number): string;
}

export interface BlockOptions {
  /**
   * Returns the fenced/indented code block containing `line`, if any. Editors
   * should answer from their syntax tree; the default scans fences from the
   * top of the document (fine for tests and small docs, O(n) otherwise).
   */
  codeBlockAt?: (line: number) => { startLine: number; endLine: number } | null;
  /** Stop scanning a block after this many lines in each direction. */
  maxLines?: number;
}

const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const QUOTE = /^ {0,3}>/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const isBlank = (s: string) => s.trim() === '';

/** Default fence scanner: walks from the top, pairing opening and closing fences. */
export function scanCodeBlocks(doc: DocAccess, uptoLine: number): (line: number) => { startLine: number; endLine: number } | null {
  return (line: number) => {
    let open: { line: number; marker: string } | null = null;
    for (let i = 0; i < doc.lineCount; i++) {
      const m = FENCE.exec(doc.lineText(i));
      if (open === null) {
        if (m) open = { line: i, marker: m[1]! };
        else if (i >= line) return null;
      } else if (m && m[1]![0] === open.marker[0] && m[1]!.length >= open.marker.length && doc.lineText(i).trim() === m[1]) {
        if (line >= open.line && line <= i) return { startLine: open.line, endLine: i };
        open = null;
        if (i >= line) return null;
      }
      if (i > uptoLine + 100_000) break;
    }
    // Unclosed fence runs to the end of the document.
    if (open !== null && line >= open.line) return { startLine: open.line, endLine: doc.lineCount - 1 };
    return null;
  };
}

/** Lines that can't continue a paragraph/list item/quote because they start their own block. */
function startsOwnBlock(text: string): boolean {
  return HEADING.test(text) || THEMATIC.test(text) || FENCE.test(text);
}

/** The markdown block containing `line`. */
export function blockAt(doc: DocAccess, line: number, options: BlockOptions = {}): Block {
  const maxLines = options.maxLines ?? 2000;
  const codeBlockAt = options.codeBlockAt ?? scanCodeBlocks(doc, line);
  const text = doc.lineText(line);

  const code = codeBlockAt(line);
  if (code) return { kind: 'code', ...code };
  if (isBlank(text)) return { kind: 'blank', startLine: line, endLine: line };
  if (HEADING.test(text)) return { kind: 'heading', startLine: line, endLine: line };
  // "- - -" / "* * *" are thematic breaks, not list items.
  if (THEMATIC.test(text)) return { kind: 'thematic-break', startLine: line, endLine: line };

  const quote = QUOTE.test(text);
  const lower = Math.max(0, line - maxLines);
  const upper = Math.min(doc.lineCount - 1, line + maxLines);
  const continues = (t: string, i: number) =>
    !isBlank(t) && !startsOwnBlock(t) && QUOTE.test(t) === quote && codeBlockAt(i) === null;

  // Walk up to the block start; a list-item marker on the way starts the block.
  let start = line;
  let listStart = LIST_ITEM.test(text) && !quote ? line : -1;
  if (listStart === -1) {
    for (let i = line - 1; i >= lower; i--) {
      const t = doc.lineText(i);
      if (!continues(t, i)) break;
      start = i;
      if (!quote && LIST_ITEM.test(t)) {
        listStart = i;
        break;
      }
    }
  }
  if (listStart !== -1) start = listStart;

  // Walk down until something that ends the block (incl. the next list item).
  let end = line;
  for (let i = line + 1; i <= upper; i++) {
    const t = doc.lineText(i);
    if (!continues(t, i) || (!quote && LIST_ITEM.test(t))) break;
    end = i;
  }

  const kind: BlockKind = quote ? 'quote' : listStart !== -1 ? 'list-item' : 'paragraph';
  return { kind, startLine: start, endLine: end };
}

// ------------------------------------------------------------------ focus

export interface FocusOptions extends BlockOptions {
  /** Max characters scanned on each side of the cursor when finding a sentence. */
  maxSentenceScan?: number;
}

export interface FocusRange extends TextRange {
  kind: BlockKind;
}

/**
 * The range to keep undimmed for a cursor at `pos`.
 * - paragraph scope: the whole block (heading, paragraph, list item, quote, code block);
 * - sentence scope: the sentence within a paragraph/list item/quote; headings and
 *   code blocks stay whole (sentence splitting inside code makes no sense);
 * - a blank line yields an empty range (everything dims).
 */
export function focusRangeAt(doc: DocAccess, pos: number, scope: FocusScope, options: FocusOptions = {}): FocusRange {
  const clamped = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(clamped);
  const block = blockAt(doc, line, options);
  if (block.kind === 'blank') return { kind: 'blank', from: clamped, to: clamped };

  const from = doc.lineStart(block.startLine);
  const to = doc.lineStart(block.endLine) + doc.lineText(block.endLine).length;
  const wholeBlock = { kind: block.kind, from, to };
  if (scope === 'paragraph' || block.kind === 'heading' || block.kind === 'code' || block.kind === 'thematic-break') {
    return wholeBlock;
  }

  const maxScan = options.maxSentenceScan ?? 4000;
  const winFrom = Math.max(from, clamped - maxScan);
  const winTo = Math.min(to, clamped + maxScan);
  const text = doc.slice(winFrom, winTo);
  const r = sentenceRangeAt(text, clamped - winFrom);
  return { kind: block.kind, from: winFrom + r.from, to: winFrom + r.to };
}

/** `DocAccess` over a plain string (tests, small documents). */
export function stringDoc(text: string): DocAccess {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return {
    length: text.length,
    lineCount: starts.length,
    lineStart: (line) => starts[line]!,
    lineText: (line) => text.slice(starts[line]!, line + 1 < starts.length ? starts[line + 1]! - 1 : text.length),
    lineAt: (pos) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    slice: (from, to) => text.slice(from, to),
  };
}
