/** User settings shared by all platforms. Persisted as JSON; see `parseSettings`. */
export type FocusScopeSetting = 'sentence' | 'paragraph' | 'off';

export interface Settings {
  /** Master focus-mode switch: hides chrome and dims per `focusScope`. */
  focusMode: boolean;
  /** What stays undimmed while focus mode is on (`off` = hide chrome only). */
  focusScope: FocusScopeSetting;
  /** Keep the caret's line vertically centred. Independent of focus mode. */
  typewriter: boolean;
  /** Library sidebar visible (never shown in focus mode). */
  sidebar: boolean;
  librarySort: 'name' | 'modified';
  /** Library-relative path of the last opened document. */
  lastDocument?: string;
  /**
   * Absolute path of the library folder (desktop). Only the main process sets
   * this (via the folder picker); renderer patches can't.
   */
  libraryDir?: string;
  /**
   * Margin server origin for sign-in (desktop). Main-process only, like
   * `libraryDir`; set by editing settings.json or MARGIN_SERVER_URL.
   * Default: http://127.0.0.1:3000 (the local dev server).
   */
  serverUrl?: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  focusMode: false,
  focusScope: 'sentence',
  typewriter: false,
  sidebar: false,
  librarySort: 'name',
});

const SCOPES: readonly FocusScopeSetting[] = ['sentence', 'paragraph', 'off'];

/** Validates a partial settings object from untrusted input; unknown keys and bad values are dropped. */
export function parseSettingsPatch(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (typeof raw.focusMode === 'boolean') out.focusMode = raw.focusMode;
  if (typeof raw.typewriter === 'boolean') out.typewriter = raw.typewriter;
  if (typeof raw.sidebar === 'boolean') out.sidebar = raw.sidebar;
  if (raw.librarySort === 'name' || raw.librarySort === 'modified') out.librarySort = raw.librarySort;
  if (typeof raw.lastDocument === 'string' && raw.lastDocument.length < 4096) out.lastDocument = raw.lastDocument;
  if (typeof raw.libraryDir === 'string' && raw.libraryDir.length < 4096) out.libraryDir = raw.libraryDir;
  if (typeof raw.serverUrl === 'string' && raw.serverUrl.length < 2048) out.serverUrl = raw.serverUrl;
  if (typeof raw.focusScope === 'string' && (SCOPES as readonly string[]).includes(raw.focusScope)) {
    out.focusScope = raw.focusScope as FocusScopeSetting;
  }
  return out;
}

/** Full settings from untrusted input (e.g. a JSON file), filling gaps with defaults. */
export function parseSettings(input: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...parseSettingsPatch(input) };
}

/** Effective dimming scope given the master switch. */
export function effectiveFocusScope(settings: Settings): 'sentence' | 'paragraph' | null {
  return settings.focusMode && settings.focusScope !== 'off' ? settings.focusScope : null;
}

/** Platform settings persistence (Electron: userData JSON; web: localStorage; native: memory). */
export interface SettingsStore {
  load(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
  /** Called when settings change from elsewhere (e.g. the desktop menu). */
  subscribe(listener: (settings: Settings) => void): () => void;
}

/** In-memory `SettingsStore`; also the base for the web/native adapters. */
export class MemorySettingsStore implements SettingsStore {
  private listeners = new Set<(s: Settings) => void>();
  private current: Settings;

  constructor(
    initial: Partial<Settings> = {},
    private readonly persist?: (s: Settings) => void,
  ) {
    this.current = parseSettings(initial);
  }

  async load(): Promise<Settings> {
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = { ...this.current, ...parseSettingsPatch(patch) };
    this.persist?.(this.current);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  subscribe(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
