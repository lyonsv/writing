import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_SETTINGS } from '@margin/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsFile } from '../src/settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'margin-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsFile', () => {
  it('defaults when missing or corrupt', async () => {
    const file = path.join(dir, 'settings.json');
    expect(await new SettingsFile(file).load()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(file, '{not json');
    expect(await new SettingsFile(file).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists validated updates and notifies', async () => {
    const file = path.join(dir, 'settings.json');
    const s = new SettingsFile(file);
    await s.load();
    const seen: boolean[] = [];
    s.onChange((v) => seen.push(v.focusMode));
    await s.update({ focusMode: true, focusScope: 'bogus', extra: 1 });
    await s.update({ focusMode: true }); // no change, no event
    expect(seen).toEqual([true]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...DEFAULT_SETTINGS, focusMode: true });
    expect((await new SettingsFile(file).load()).focusMode).toBe(true);
  });
});
