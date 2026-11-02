import { DEFAULT_SETTINGS, type Settings } from '@margin/core';
import { useCallback, useEffect, useState } from 'react';

import type { EditorCommand } from '../components/editor/MarkdownEditor';
import { getSettingsStore } from './storage/documentStore';

/** Current settings plus an updater; stays in sync with changes from the desktop menu. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const store = getSettingsStore();
    let cancelled = false;
    void store.load().then((s) => {
      if (!cancelled) setSettings(s);
    });
    const off = store.subscribe((s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await getSettingsStore().update(patch);
    setSettings(next);
  }, []);

  /** Applies an editor keyboard command (used where there's no app menu). */
  const runCommand = useCallback(
    async (command: EditorCommand) => {
      const s = await getSettingsStore().load();
      switch (command) {
        case 'toggle-focus':
          return update({ focusMode: !s.focusMode });
        case 'toggle-typewriter':
          return update({ typewriter: !s.typewriter });
        case 'scope-sentence':
          return update({ focusScope: 'sentence' });
        case 'scope-paragraph':
          return update({ focusScope: 'paragraph' });
        case 'scope-off':
          return update({ focusScope: 'off' });
      }
    },
    [update],
  );

  return { settings, update, runCommand };
}
