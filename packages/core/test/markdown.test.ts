import { describe, expect, it } from 'vitest';
import { characterCount, extractTitle, fileNameFromTitle, readingMinutes, toPlainText, wordCount } from '../src';

describe('extractTitle', () => {
  it('prefers the first heading', () => {
    expect(extractTitle('intro line\n\n## The *Real* Title ##\n')).toBe('The Real Title');
  });

  it('falls back to the first non-empty line without list/quote markers', () => {
    expect(extractTitle('\n\n> A [linked](http://x) thought\nmore')).toBe('A linked thought');
  });

  it('ignores front matter', () => {
    expect(extractTitle('---\ntitle: x\n---\n# Hello')).toBe('Hello');
  });

  it('returns null for empty documents', () => {
    expect(extractTitle('   \n\n')).toBeNull();
  });
});

describe('counts', () => {
  const doc = '# Title\n\nIt’s a **bold** move — twenty-one words? No.\n\n```\ncode is not counted\n```\n';

  it('counts words in prose only', () => {
    expect(wordCount(doc)).toBe(8);
    expect(wordCount('')).toBe(0);
  });

  it('counts non-whitespace characters', () => {
    expect(characterCount('# ab c')).toBe(3);
  });

  it('computes reading time', () => {
    expect(readingMinutes('')).toBe(0);
    expect(readingMinutes('word '.repeat(231))).toBe(2);
  });

  it('strips block markers in plain text', () => {
    expect(toPlainText('- item\n> quote\n1. one')).toBe('item\nquote\none');
  });
});

describe('fileNameFromTitle', () => {
  it('removes unsafe characters', () => {
    expect(fileNameFromTitle('a/b:c*?')).toBe('a b c');
    expect(fileNameFromTitle('..hidden')).toBe('hidden');
    expect(fileNameFromTitle('   ')).toBe('Untitled');
  });
});
