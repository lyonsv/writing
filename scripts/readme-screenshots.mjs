#!/usr/bin/env node
/**
 * README screenshots of the desktop app (`pnpm docs:screenshots`), taken with
 * Playwright from the built app (`pnpm build:desktop` first) against a temp
 * library of sample documents. Never touches ~/Documents/Margin.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron');
const outDir = path.join(repo, 'docs/images');
mkdirSync(outDir, { recursive: true });

const DOC = `# On margins

The blank space around a page is not empty. It is where the eye rests between lines, where a reader's pencil goes, where the writer can see the shape of a paragraph before its words.

Margin is built around that space. There is a column of text, a caret, and nothing else. Markdown stays plain text: **bold** and *italic* are styled as you type, and the markers fade back so they don't shout.

When you turn on focus mode, everything but the sentence you are writing dims. It sounds like a small thing. It changes how a draft feels: you stop rereading and keep going.

> Write drunk; edit sober. Or at least: write first, edit later.

- Plain \`.md\` files in a folder you choose
- Focus on a sentence or a paragraph
- Typewriter scrolling keeps your line in the middle of the screen
`;

const files = {
  'Essays/On margins.md': DOC,
  'Essays/Notes on rhythm.md': '# Notes on rhythm\n\nShort sentences land. Longer ones carry the reader along, gathering clauses as they go.\n',
  'Journal/2026-11-02.md': '# Monday\n\nStarted the new draft.\n',
  'Ideas.md': '# Ideas\n\n- A story told in footnotes\n',
};

async function shoot(name, settings, act) {
  const lib = mkdtempSync(path.join(tmpdir(), 'margin-shot-lib-'));
  const ud = mkdtempSync(path.join(tmpdir(), 'margin-shot-ud-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(lib, p)), { recursive: true });
    writeFileSync(path.join(lib, p), text);
  }
  writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ welcomed: true, lastDocument: 'Essays/On margins.md', ...settings }));
  const env = { ...process.env, MARGIN_LIBRARY_DIR: lib, MARGIN_USER_DATA_DIR: ud, MARGIN_SHOW_INACTIVE: '1' };
  delete env.MARGIN_DEV_SERVER_URL; // serve the built export over app://
  const app = await electron.launch({ executablePath: electronBinary, args: [path.join(repo, 'apps/desktop/dist/main.js')], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await page.emulateMedia({ colorScheme: settings.dark ? 'dark' : 'light' });
    await page.getByTestId('editor').waitFor();
    await page.waitForFunction(() => document.fonts.check("18px 'IBM Plex Mono'"));
    await act?.(page);
    await page.waitForTimeout(600); // focus fades
    await page.screenshot({ path: path.join(outDir, name) });
    console.log(`docs/images/${name}`);
  } finally {
    await app.close();
    rmSync(lib, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
}

const caretIn = (needle) => async (page) => {
  const line = page.locator('.cm-line', { hasText: needle }).first();
  await line.click({ position: { x: 120, y: 10 } });
};

await shoot('margin-library.png', { sidebar: true }, caretIn('Margin is built around'));
await shoot('margin-focus.png', { focusMode: true, focusScope: 'sentence', typewriter: true }, caretIn('When you turn on focus mode'));
await shoot('margin-dark.png', { sidebar: false, dark: true }, caretIn('The blank space'));
