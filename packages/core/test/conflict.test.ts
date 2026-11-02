import { describe, expect, it } from 'vitest';
import { conflictCopyPath, conflictTimestamp, isConflictCopy, isHiddenPath } from '../src';

const when = new Date(2026, 10, 2, 9, 5);

describe('conflict copies', () => {
  it('formats a local timestamp', () => {
    expect(conflictTimestamp(when)).toBe('2026-11-02 0905');
  });

  it('names the copy next to the original', () => {
    expect(conflictCopyPath('notes/Draft.md', when)).toBe('notes/Draft (conflict 2026-11-02 0905).md');
    expect(conflictCopyPath('Untitled.md', when, 3)).toBe('Untitled (conflict 2026-11-02 0905 3).md');
    expect(conflictCopyPath('plain', when)).toBe('plain (conflict 2026-11-02 0905).md');
  });

  it('recognises conflict copies', () => {
    expect(isConflictCopy(conflictCopyPath('a.md', when))).toBe(true);
    expect(isConflictCopy(conflictCopyPath('a.md', when, 2))).toBe(true);
    expect(isConflictCopy('a.md')).toBe(false);
  });

  it('detects hidden segments', () => {
    expect(isHiddenPath('.git/config')).toBe(true);
    expect(isHiddenPath('notes/.hidden.md')).toBe(true);
    expect(isHiddenPath('notes/a.md')).toBe(false);
  });
});
