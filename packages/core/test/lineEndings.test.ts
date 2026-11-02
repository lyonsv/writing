import { describe, expect, it } from 'vitest';
import { detectLineEnding, withLineEnding } from '../src';

describe('line endings', () => {
  it('detects the dominant ending', () => {
    expect(detectLineEnding('')).toBe('\n');
    expect(detectLineEnding('one line')).toBe('\n');
    expect(detectLineEnding('a\nb\n')).toBe('\n');
    expect(detectLineEnding('a\r\nb\r\n')).toBe('\r\n');
    expect(detectLineEnding('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectLineEnding('a\nb\nc\r\n')).toBe('\n');
    expect(detectLineEnding('a\rb\r')).toBe('\r');
  });

  it('restores the ending on LF editor text', () => {
    expect(withLineEnding('a\nb\n', '\n')).toBe('a\nb\n');
    expect(withLineEnding('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(withLineEnding('a\nb', '\r')).toBe('a\rb');
  });

  it('round-trips CRLF through LF normalisation', () => {
    const original = '# Title\r\n\r\nBody line\r\n';
    const editor = original.replace(/\r\n/g, '\n') + 'more\n';
    expect(withLineEnding(editor, detectLineEnding(original))).toBe('# Title\r\n\r\nBody line\r\nmore\r\n');
  });
});
