import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SETTINGS, parseSettings, parseSettingsPatch, type Settings } from '@margin/core';

/** Settings persisted as JSON in Electron's userData folder. Single writer: the main process. */
export class SettingsFile {
  private current: Settings = { ...DEFAULT_SETTINGS };
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      this.current = parseSettings(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Margin: ignoring unreadable settings file ${this.file}`, error);
      }
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  /** Resolves when every pending write has landed (awaited before quitting). */
  idle(): Promise<void> {
    return this.writing;
  }

  get(): Settings {
    return this.current;
  }

  update(patch: unknown): Promise<Settings> {
    const next = { ...this.current, ...parseSettingsPatch(patch) };
    const changed = (Object.keys(next) as (keyof Settings)[]).some((k) => next[k] !== this.current[k]);
    this.current = next;
    if (!changed) return Promise.resolve(next);
    for (const l of this.listeners) l(next);
    // Serialised atomic writes; the latest state always lands last.
    this.writing = this.writing.then(() => this.persist(next)).catch((error: unknown) => {
      console.error('Margin: failed to save settings', error);
    });
    return this.writing.then(() => next);
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async persist(settings: Settings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.file);
  }
}
