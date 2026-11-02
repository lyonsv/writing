import { MemorySettingsStore, parseSettings, type DesktopBridge, type Settings, type SettingsStore } from '@margin/core';

/** Electron: the main process owns settings.json (userData) and the menu. */
export function desktopSettingsStore(bridge: DesktopBridge): SettingsStore {
  return {
    load: () => bridge.settings.load(),
    update: (patch) => bridge.settings.update(patch),
    subscribe: (listener) => bridge.settings.onChange(listener),
  };
}

const STORAGE_KEY = 'margin.settings.v1';

/** Browser: localStorage. */
export function localStorageSettingsStore(storage: Storage = window.localStorage): SettingsStore {
  let initial: Partial<Settings> = {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) initial = parseSettings(JSON.parse(raw));
  } catch {
    // corrupt or unavailable storage: defaults
  }
  return new MemorySettingsStore(initial, (s) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // private mode etc.: settings just won't persist
    }
  });
}
