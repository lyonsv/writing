import { createContext, useContext, useEffect, type ReactNode } from 'react';

import { setWorkspaceFlush } from './local/lifecycle';
import { useSettings } from './useSettings';
import { useWorkspace } from './useWorkspace';

/**
 * Phone layouts (iOS, and the web app on a phone): one workspace (settings, library listing, open document and its save
 * pipeline) shared by the stack's screens: the library list, the editor and
 * settings. Desktop/web keep everything in one screen and don't use this.
 */
function useWorkspaceState() {
  const settings = useSettings();
  const ws = useWorkspace(settings.settings, settings.loaded, settings.update);
  return { ...settings, ws };
}

export type WorkspaceState = ReturnType<typeof useWorkspaceState>;

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const state = useWorkspaceState();
  const flush = state.ws.flush;
  // Sync and the app going to the background flush through the workspace first.
  useEffect(() => setWorkspaceFlush(flush), [flush]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useShared(): WorkspaceState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useShared outside WorkspaceProvider');
  return s;
}
