import { MemorySettingsStore, decodeUtf8, encodeUtf8, parseSettings, type Settings, type SettingsStore } from '@margin/core';

import type { NativeFs } from './nativeFs';

/**
 * iOS preferences: a JSON file in the app's private storage
 * (`.margin/settings.json`, outside the library), written atomically. Secrets
 * never go here: the device token is in the Keychain (expo-secure-store).
 */
export class FileSettingsStore implements SettingsStore {
  private inner: Promise<MemorySettingsStore> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: Settings) => void>();

  constructor(
    private readonly fs: NativeFs,
    private readonly file = '.margin/settings.json',
  ) {}

  private store(): Promise<MemorySettingsStore> {
    this.inner ??= (async () => {
      let initial: Partial<Settings> = {};
      try {
        initial = parseSettings(JSON.parse(decodeUtf8(await this.fs.readBytes(this.file)) ?? '{}'));
      } catch {
        /* missing or corrupt: defaults */
      }
      return new MemorySettingsStore(initial, (s) => {
        const bytes = encodeUtf8(JSON.stringify(s));
        // Serialised and atomic, so the newest settings always win on disk.
        this.writes = this.writes
          .then(async () => {
            await this.fs.mkdir(this.file.slice(0, this.file.lastIndexOf('/')));
            await this.fs.writeAtomic(this.file, bytes);
          })
          .catch((e: unknown) => console.error('Margin: could not save settings', e));
      });
    })();
    return this.inner;
  }

  async load(): Promise<Settings> {
    return (await this.store()).load();
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const s = await (await this.store()).update(patch);
    for (const l of this.listeners) l(s);
    return s;
  }

  subscribe(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Resolves once queued writes have reached disk. */
  flushed(): Promise<void> {
    return this.writes;
  }
}
