import { DEFAULT_SETTINGS, type Settings } from '@margin/core';
import { useCallback, useEffect, useState } from 'react';

import { getSettingsStore } from './storage/documentStore';

/** Current settings plus an updater; stays in sync with changes from the desktop menu. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const store = getSettingsStore();
    let cancelled = false;
    void store.load().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoaded(true);
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
    setSettings(await getSettingsStore().update(patch));
  }, []);

  /** Toggles that keep the "sidebar never in focus mode" rule. */
  const toggleFocus = useCallback(async () => {
    const s = await getSettingsStore().load();
    await update({ focusMode: !s.focusMode });
  }, [update]);

  const toggleSidebar = useCallback(async () => {
    const s = await getSettingsStore().load();
    await update(s.focusMode ? { focusMode: false, sidebar: true } : { sidebar: !s.sidebar });
  }, [update]);

  return { settings, loaded, update, toggleFocus, toggleSidebar };
}
