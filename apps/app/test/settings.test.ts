import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEV_SERVER_URL, PRODUCTION_SERVER_URL, defaultServerUrl } from '@margin/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSettingsStore } from '../src/local/settings';
import { NodeFs } from './nodeFs';

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'margin-settings-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('iOS settings file', () => {
  it('persists validated settings (last write wins) and survives a reload', async () => {
    const store = new FileSettingsStore(new NodeFs(base));
    await store.update({ focusMode: true });
    await store.update({ focusScope: 'paragraph', serverUrl: 'https://example.com', bogus: 1 } as never);
    await store.flushed();
    const onDisk = JSON.parse(readFileSync(path.join(base, '.margin/settings.json'), 'utf8'));
    expect(onDisk).toMatchObject({ focusMode: true, focusScope: 'paragraph', serverUrl: 'https://example.com' });
    expect(onDisk.bogus).toBeUndefined();
    expect(await new FileSettingsStore(new NodeFs(base)).load()).toMatchObject({ focusMode: true, focusScope: 'paragraph' });
  });

  it('a corrupt file falls back to defaults', async () => {
    mkdirSync(path.join(base, '.margin'));
    writeFileSync(path.join(base, '.margin/settings.json'), '{not json');
    expect((await new FileSettingsStore(new NodeFs(base)).load()).focusMode).toBe(false);
  });

  it('server defaults: production for packaged/release builds, the local dev server otherwise', () => {
    expect(defaultServerUrl(true)).toBe(PRODUCTION_SERVER_URL);
    expect(PRODUCTION_SERVER_URL).toBe('https://margin-sync.vercel.app');
    expect(defaultServerUrl(false)).toBe(DEV_SERVER_URL);
    expect(DEV_SERVER_URL).toBe('http://127.0.0.1:3000');
  });
});
