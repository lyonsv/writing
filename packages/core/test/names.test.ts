import { describe, expect, it } from 'vitest';

import {
  MAX_FILENAME_BYTES,
  MAX_NAME_BYTES,
  basename,
  conflictCopyPath,
  isConflictCopy,
  renamedPath,
  truncateUtf8,
  uniqueName,
  utf8Length,
  validateName,
} from '../src';

describe('name length is measured in UTF-8 bytes', () => {
  it('counts bytes per code point', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('日本')).toBe(6);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('😀')).toBe(Buffer.byteLength('😀'));
  });

  it('truncates on code-point boundaries', () => {
    expect(truncateUtf8('a😀b', 4)).toBe('a');
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('éé', 3)).toBe('é');
  });

  it('validateName refuses names over the byte budget even when short in characters', () => {
    expect(validateName('a'.repeat(MAX_NAME_BYTES))).toBeNull();
    expect(validateName('a'.repeat(MAX_NAME_BYTES + 1))).toMatch(/too long/);
    expect(validateName('é'.repeat(100))).toBeNull(); // 200 bytes
    expect(validateName('é'.repeat(101))).toMatch(/too long/); // 101 chars, 202 bytes
    expect(validateName('日'.repeat(67))).toMatch(/too long/); // 67 chars, 201 bytes
    expect(validateName('😀'.repeat(51))).toMatch(/too long/); // 102 UTF-16 units, 204 bytes
  });

  it('every name derived from a valid name still fits in 255 bytes', () => {
    const when = new Date(2026, 10, 2, 9, 5);
    for (const name of ['a'.repeat(MAX_NAME_BYTES), 'é'.repeat(100), '日'.repeat(66), '😀'.repeat(50)]) {
      expect(validateName(name)).toBeNull();
      const doc = basename(renamedPath('x.md', name, 'document'));
      expect(utf8Length(doc)).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(utf8Length(basename(conflictCopyPath(doc, when, 99)))).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(utf8Length(uniqueName(name, [`${name}.md`], '.md').replace(/ \d+\.md$/, ' 99.md'))).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
    }
  });

  it('conflict copies of an over-long existing name are shortened to fit', () => {
    const when = new Date(2026, 10, 2, 9, 5);
    for (const stem of ['L'.repeat(250), 'é'.repeat(125), '😀'.repeat(62)]) {
      const copy = conflictCopyPath(`notes/${stem}.md`, when, 12);
      expect(utf8Length(basename(copy))).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
      expect(copy.startsWith('notes/')).toBe(true);
      expect(isConflictCopy(copy)).toBe(true);
      expect(copy).not.toContain('�');
    }
  });
});
