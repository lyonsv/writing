// Checks the packaged Margin.app: its Electron fuses are set as configured,
// and it launches, opens the default document and quits cleanly on SIGTERM.
// Playwright can't attach to the fused binary, so this is a black-box check.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = ['mac-arm64', 'mac', 'mac-universal']
  .map((d) => path.join(root, 'release', d, 'Margin.app'))
  .find((p) => existsSync(p));
if (!appPath) throw new Error('No packaged Margin.app; run `pnpm build:desktop` first.');

const expected = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};
const wire = await getCurrentFuseWire(appPath);
if (wire.version !== FuseVersion.V1) throw new Error(`Unexpected fuse wire version ${wire.version}`);
const failures = [];
for (const [name, want] of Object.entries(expected)) {
  const raw = wire[FuseV1Options[name]];
  // '1' = enabled, '0' = disabled (ASCII codes 49/48).
  const actual = raw === 49 || raw === '1' || raw === 1 ? true : raw === 48 || raw === '0' || raw === 0 ? false : raw;
  console.log(`fuse ${name}: ${actual}`);
  if (actual !== want) failures.push(`${name}: expected ${want}, got ${actual}`);
}
if (failures.length) throw new Error(`Fuse check failed:\n${failures.join('\n')}`);

const lib = mkdtempSync(path.join(tmpdir(), 'margin-pkg-lib-'));
const ud = mkdtempSync(path.join(tmpdir(), 'margin-pkg-ud-'));
const child = spawn(path.join(appPath, 'Contents/MacOS/Margin'), [], {
  env: { ...process.env, MARGIN_LIBRARY_DIR: lib, MARGIN_USER_DATA_DIR: ud, MARGIN_SHOW_INACTIVE: '1' },
  stdio: 'inherit',
});
// An empty library gets a new date-named document on first launch (ADR 0008).
const firstDoc = () => readdirSync(lib).find((f) => f.endsWith('.md'));
const start = Date.now();
while (!firstDoc() && Date.now() - start < 30_000) await new Promise((r) => setTimeout(r, 250));
if (!firstDoc()) {
  child.kill('SIGKILL');
  throw new Error('Packaged app did not create its first document within 30s');
}
const doc = path.join(lib, firstDoc());
console.log(`packaged app opened ${doc} (${JSON.stringify(readFileSync(doc, 'utf8'))})`);
const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
child.kill('SIGTERM');
const result = await Promise.race([exit, new Promise((r) => setTimeout(() => r('timeout'), 15_000))]);
rmSync(lib, { recursive: true, force: true });
rmSync(ud, { recursive: true, force: true });
if (result === 'timeout') {
  child.kill('SIGKILL');
  throw new Error('Packaged app did not quit within 15s of SIGTERM');
}
console.log('packaged app quit:', JSON.stringify(result));
console.log('verify:packaged OK');
