/**
 * A desktop "device" for e2e/web/pwa.spec.ts: the real desktop library
 * (FileSystemLibrary) + AccountManager + SyncService, bundled with esbuild and run
 * as a child process (Playwright's loader can't import @margin/core's raw TS).
 *
 *   node desktopDevice.mjs <serverUrl> <dir> sync [<relativePath> <text>]
 *
 * Signs in on first use (session kept in <dir>), optionally writes a file into
 * the library, syncs, and prints the library as JSON (path → text).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AccountManager } from '../../apps/desktop/src/account';
import { FileSystemLibrary } from '../../apps/desktop/src/library';
import { SyncService } from '../../apps/desktop/src/sync';
import { browse } from '../../apps/server/test/mockGitHubHttp';

const [serverUrl, dir, , file, text] = process.argv.slice(2) as [string, string, string, string?, string?];
const root = path.join(dir, 'library');
mkdirSync(root, { recursive: true });
const library = new FileSystemLibrary(root);
await library.init();
const account = new AccountManager({
  file: path.join(dir, 'session.bin'),
  serverUrl: () => serverUrl,
  openExternal: async (u) => void browse(u),
  secretBox: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
  deviceName: () => 'Mac',
});
await account.load();
if (account.status().state !== 'signed-in') await account.signIn();
if (file && text !== undefined) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}
const sync = new SyncService({ library: () => library, account, stateDir: path.join(dir, 'sync'), trash: async (abs) => rmSync(abs) });
const status = await sync.syncNow();
const out: Record<string, string> = {};
const walk = (rel: string) => {
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.md') && existsSync(path.join(root, p))) out[p] = readFileSync(path.join(root, p), 'utf8');
  }
};
walk('');
console.log(JSON.stringify({ status: status.state, files: out }));
library.dispose();
