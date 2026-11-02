import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const repo = path.resolve(import.meta.dirname, '..');
const electronBinary = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron') as unknown as string;

export const newLibrary = () => mkdtempSync(path.join(tmpdir(), 'margin-e2e-lib-'));

/**
 * Launches the built main process (`apps/desktop/dist/main.js`) with the stock
 * Electron binary, serving the static Expo export over app://.
 *
 * The packaged Margin.app can't be driven by Playwright: its Electron fuses
 * disable `--inspect`/`--remote-debugging` style attachment. It is checked
 * separately by `pnpm --filter @margin/desktop verify:packaged`.
 */
export async function launch(libraryDir: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'margin-e2e-ud-'));
  const env = {
    ...process.env,
    MARGIN_LIBRARY_DIR: libraryDir,
    MARGIN_USER_DATA_DIR: userDataDir,
    MARGIN_SHOW_INACTIVE: '1',
    ...extraEnv,
  } as Record<string, string>;
  delete env.MARGIN_DEV_SERVER_URL;
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [path.join(repo, 'apps/desktop/dist/main.js')],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log(`[renderer] pageerror: ${e.message}`));
  return app;
}

/** Quits via app.quit() (like Cmd+Q) and waits for the process to exit. */
export async function quitAndWait(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  await app.evaluate(({ app: a }) => a.quit());
  await exited;
}
