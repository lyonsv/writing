import { describe, expect, it } from 'vitest';
import { blockAt, focusRangeAt, sentenceEnds, sentenceRangeAt, stringDoc } from '../src';

/** Splits text into sentences using sentenceEnds. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const end of [...sentenceEnds(text), text.length]) {
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  return [...new Set(out)];
}

/** The sentence around the `|` marker. */
function sentenceAt(marked: string): string {
  const pos = marked.indexOf('|');
  const text = marked.replace('|', '');
  const r = sentenceRangeAt(text, pos);
  return text.slice(r.from, r.to);
}

describe('sentence boundaries', () => {
  it('splits on . ! ?', () => {
    expect(sentences('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
  });

  it.each([
    ['Mr. Smith met Dr. Jones. They talked.', ['Mr. Smith met Dr. Jones.', 'They talked.']],
    ['Use a tool, e.g. Vim or i.e. Emacs. Then save.', ['Use a tool, e.g. Vim or i.e. Emacs.', 'Then save.']],
    ['See e.g. Paris. Next.', ['See e.g. Paris.', 'Next.']],
    ['Apples, pears, etc. are fruit. Yes.', ['Apples, pears, etc. are fruit.', 'Yes.']],
    ['We bought apples, pears, etc. Then we left.', ['We bought apples, pears, etc.', 'Then we left.']],
    ['J. R. R. Tolkien wrote it. Indeed.', ['J. R. R. Tolkien wrote it.', 'Indeed.']],
    ['See No. 5 and p. 12 for details. Done.', ['See No. 5 and p. 12 for details.', 'Done.']],
    ['I said no. Then I left.', ['I said no.', 'Then I left.']],
    ['Pi is 3.14 roughly. Yes.', ['Pi is 3.14 roughly.', 'Yes.']],
    ['He works in the U.S. now. He likes it.', ['He works in the U.S. now.', 'He likes it.']],
    ['She came 1st. Then him.', ['She came 1st.', 'Then him.']],
    ['Visit example.com today. Ok.', ['Visit example.com today.', 'Ok.']],
  ])('handles abbreviations and numbers: %j', (text, expected) => {
    expect(sentences(text)).toEqual(expected);
  });

  it.each([
    ['Wait... what happened? Nothing.', ['Wait... what happened?', 'Nothing.']],
    ['I see... Then he left.', ['I see...', 'Then he left.']],
    ['Hmm… Maybe. Or not…', ['Hmm…', 'Maybe.', 'Or not…']],
  ])('handles ellipses: %j', (text, expected) => {
    expect(sentences(text)).toEqual(expected);
  });

  it.each([
    ['He said "Stop." Then he left.', ['He said "Stop."', 'Then he left.']],
    ['“Really?” she asked. “Yes!”', ['“Really?” she asked.', '“Yes!”']],
    ['It was (mostly) fine.) Next.', ['It was (mostly) fine.)', 'Next.']],
    ['This is *important.* Read it.', ['This is *important.*', 'Read it.']],
    ['Really?! Yes.', ['Really?!', 'Yes.']],
    ["Is it 'ok'? Sure.", ["Is it 'ok'?", 'Sure.']],
  ])('keeps closing quotes and brackets with the sentence: %j', (text, expected) => {
    expect(sentences(text)).toEqual(expected);
  });

  it('treats soft line breaks inside a paragraph as spaces', () => {
    expect(sentences('First line\ncontinues here. Second\nsentence.')).toEqual([
      'First line\ncontinues here.',
      'Second\nsentence.',
    ]);
  });

  it('places the cursor in the right sentence', () => {
    expect(sentenceAt('One. Tw|o. Three.')).toBe('Two.');
    expect(sentenceAt('|One. Two.')).toBe('One.');
    expect(sentenceAt('One.| Two.')).toBe('One.'); // right after the terminator: still typing it
    expect(sentenceAt('One. |Two.')).toBe('Two.');
    expect(sentenceAt('One. Two.|')).toBe('Two.');
    expect(sentenceAt('One. Two |')).toBe('Two '); // grows to keep the caret inside
    expect(sentenceAt('Unterminated sente|nce')).toBe('Unterminated sentence');
    expect(sentenceAt('|')).toBe('');
  });
});

describe('markdown blocks', () => {
  const doc = stringDoc(
    [
      '# Heading', //               0
      '', //                        1
      'Para line one', //           2
      'para line two.', //          3
      '', //                        4
      '- item one', //              5
      '  continues', //             6
      '- item two', //              7
      '1. numbered', //             8
      '', //                        9
      '> quoted', //                10
      '> more quote', //            11
      'after quote', //             12
      '', //                        13
      '```js', //                   14
      'const a = 1. B = 2;', //     15
      '', //                        16
      '```', //                     17
      '---', //                     18
      'tail', //                    19
    ].join('\n'),
  );

  it.each([
    [0, 'heading', 0, 0],
    [1, 'blank', 1, 1],
    [2, 'paragraph', 2, 3],
    [3, 'paragraph', 2, 3],
    [5, 'list-item', 5, 6],
    [6, 'list-item', 5, 6],
    [7, 'list-item', 7, 7],
    [8, 'list-item', 8, 8],
    [10, 'quote', 10, 11],
    [11, 'quote', 10, 11],
    [12, 'paragraph', 12, 12],
    [14, 'code', 14, 17],
    [16, 'code', 14, 17], // blank line inside a fence is still code
    [18, 'thematic-break', 18, 18],
    [19, 'paragraph', 19, 19],
  ])('line %i is %s [%i..%i]', (line, kind, startLine, endLine) => {
    expect(blockAt(doc, line)).toEqual({ kind, startLine, endLine });
  });

  it('treats an unclosed fence as code to the end', () => {
    const d = stringDoc('text\n~~~\ncode\nmore');
    expect(blockAt(d, 3)).toEqual({ kind: 'code', startLine: 1, endLine: 3 });
    expect(blockAt(d, 0)).toEqual({ kind: 'paragraph', startLine: 0, endLine: 0 });
  });

  it('uses an injected code-block locator instead of scanning', () => {
    const d = stringDoc('a\nb\nc');
    const calls: number[] = [];
    const b = blockAt(d, 1, {
      codeBlockAt: (l) => {
        calls.push(l);
        return null;
      },
    });
    expect(b).toEqual({ kind: 'paragraph', startLine: 0, endLine: 2 });
    expect(calls).toContain(1);
  });

  it('caps scanning with maxLines', () => {
    const d = stringDoc(Array.from({ length: 50 }, () => 'line').join('\n'));
    expect(blockAt(d, 25, { maxLines: 5 })).toEqual({ kind: 'paragraph', startLine: 20, endLine: 30 });
  });
});

describe('focusRangeAt', () => {
  const text = '# Title. With dot\n\nFirst sentence. Second one here.\n\n```\nx. Y.\n```\n- Item one. Item two.';
  const doc = stringDoc(text);
  const at = (needle: string, scope: 'sentence' | 'paragraph') => {
    const r = focusRangeAt(doc, text.indexOf(needle), scope);
    return text.slice(r.from, r.to);
  };

  it('sentence scope', () => {
    expect(at('Second', 'sentence')).toBe('Second one here.');
    expect(at('Item two', 'sentence')).toBe('Item two.');
    expect(at('Item one', 'sentence')).toBe('- Item one.');
  });

  it('keeps headings and code blocks whole', () => {
    expect(at('With dot', 'sentence')).toBe('# Title. With dot');
    expect(at('Y.', 'sentence')).toBe('```\nx. Y.\n```');
  });

  it('paragraph scope', () => {
    expect(at('Second', 'paragraph')).toBe('First sentence. Second one here.');
  });

  it('blank lines focus nothing', () => {
    const r = focusRangeAt(doc, text.indexOf('\n\n') + 1, 'paragraph');
    expect(r).toMatchObject({ kind: 'blank' });
    expect(r.from).toBe(r.to);
  });

  it('only scans a bounded window of a huge paragraph', () => {
    const huge = 'x'.repeat(2_000_000) + '. Next.';
    const d = stringDoc(huge);
    let sliced = 0;
    const counting = { ...d, slice: (a: number, b: number) => ((sliced += b - a), d.slice(a, b)) };
    const r = focusRangeAt(counting, 1_000_000, 'sentence', { maxSentenceScan: 1000 });
    expect(sliced).toBeLessThanOrEqual(2000);
    expect(r.from).toBe(999_000);
    expect(r.to).toBe(1_001_000);
  });
});
