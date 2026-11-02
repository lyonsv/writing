import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MemorySettingsStore, effectiveFocusScope, parseSettings, parseSettingsPatch } from '../src';

describe('settings', () => {
  it('parses untrusted input, dropping bad values', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ focusMode: true, focusScope: 'paragraph', typewriter: 'yes', evil: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      focusMode: true,
      focusScope: 'paragraph',
    });
    expect(parseSettingsPatch({ sidebar: true, librarySort: 'modified', lastDocument: 'a/b.md', libraryDir: '/x' })).toEqual({
      sidebar: true,
      librarySort: 'modified',
      lastDocument: 'a/b.md',
      libraryDir: '/x',
    });
    expect(parseSettingsPatch({ librarySort: 'size', lastDocument: 5 })).toEqual({});
    expect(parseSettingsPatch({ focusScope: 'line' })).toEqual({});
  });

  it('computes the effective scope', () => {
    expect(effectiveFocusScope({ ...DEFAULT_SETTINGS, focusMode: false })).toBeNull();
    expect(effectiveFocusScope({ ...DEFAULT_SETTINGS, focusMode: true, focusScope: 'off' })).toBeNull();
    expect(effectiveFocusScope({ ...DEFAULT_SETTINGS, focusMode: true, focusScope: 'paragraph' })).toBe('paragraph');
  });

  it('memory store updates, persists and notifies', async () => {
    const persisted: unknown[] = [];
    const seen: unknown[] = [];
    const store = new MemorySettingsStore({ typewriter: true }, (s) => persisted.push(s));
    store.subscribe((s) => seen.push(s.focusMode));
    expect((await store.load()).typewriter).toBe(true);
    await store.update({ focusMode: true });
    expect(seen).toEqual([true]);
    expect(persisted).toHaveLength(1);
  });
});
