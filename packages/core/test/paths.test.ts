import { describe, expect, it } from 'vitest';
import {
  InvalidPathError,
  basename,
  dirname,
  displayName,
  ensureMarkdownExtension,
  isWithin,
  joinDocPath,
  normalizeDocPath,
} from '../src';

describe('normalizeDocPath', () => {
  it('accepts simple relative paths', () => {
    expect(normalizeDocPath('draft.md')).toBe('draft.md');
    expect(normalizeDocPath('notes/ideas/draft.md')).toBe('notes/ideas/draft.md');
  });

  it('collapses duplicate and trailing slashes', () => {
    expect(normalizeDocPath('notes//ideas/')).toBe('notes/ideas');
  });

  it.each([
    ['../secret.md'],
    ['notes/../../etc/passwd'],
    ['./draft.md'],
    ['/etc/passwd'],
    ['C:/Windows'],
    ['notes\\..\\x'],
    ['a\0b'],
  ])('rejects %j', (input) => {
    expect(() => normalizeDocPath(input)).toThrow(InvalidPathError);
  });

  it('rejects the root unless allowed', () => {
    expect(() => normalizeDocPath('')).toThrow(InvalidPathError);
    expect(normalizeDocPath('', { allowRoot: true })).toBe('');
  });
});

describe('path helpers', () => {
  it('joins and splits', () => {
    expect(joinDocPath('notes', '', 'a.md')).toBe('notes/a.md');
    expect(basename('notes/a.md')).toBe('a.md');
    expect(dirname('notes/a.md')).toBe('notes');
    expect(dirname('a.md')).toBe('');
  });

  it('handles markdown extensions', () => {
    expect(ensureMarkdownExtension('a')).toBe('a.md');
    expect(ensureMarkdownExtension('a.MD')).toBe('a.MD');
    expect(displayName('notes/My Draft.md')).toBe('My Draft');
  });

  it('isWithin respects segment boundaries', () => {
    expect(isWithin('notes', 'notes/a.md')).toBe(true);
    expect(isWithin('notes', 'notes')).toBe(true);
    expect(isWithin('notes', 'notes2/a.md')).toBe(false);
    expect(isWithin('', 'anything')).toBe(true);
  });
});
