#!/usr/bin/env node
/**
 * Every README image, reproducibly (`pnpm docs:screenshots`; `--only=desktop,phone,hero,gif`).
 * Needs the built desktop app and web export (`pnpm build:desktop`), Playwright's
 * Chromium and WebKit, and ffmpeg (for the GIF). Writes optimised files to docs/images/.
 * Never touches ~/Documents/Margin: every run uses temp folders / fresh browser storage.
 *
 *   desktop  margin-library.png, margin-focus.png, margin-dark.png  (the real Electron app, 1280×800 @2x)
 *   phone    iphone-library.png, iphone-editor.png, iphone-focus.png (the web app on a phone, 390×844 @3x, WebKit)
 *   hero     hero-light.webp, hero-dark.webp   (a composed "Mac + iPhone" shot; original, neutral frames)
 *   gif      focus-mode.gif                    (typing in focus mode with typewriter scrolling)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, chromium, webkit } from '@playwright/test';
import sharp from 'sharp';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron');
const outDir = path.join(repo, 'docs/images');
const dist = path.join(repo, 'apps/app/dist');
mkdirSync(outDir, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=desktop,phone,hero,gif').slice(7).split(',');

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

const out = (name) => path.join(outDir, name);
const written = [];

/** Lossless-looking palette PNG (UI greys quantise well); much smaller than raw screenshots. */
async function savePng(name, buffer, width) {
  let img = sharp(buffer);
  if (width) img = img.resize({ width });
  const data = await img.png({ palette: true, quality: 92, effort: 10, compressionLevel: 9 }).toBuffer();
  writeFileSync(out(name), data);
  written.push(name);
}

// ------------------------------------------------------------------ desktop (Electron)

async function desktopShot(name, settings, act) {
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
    await savePng(name, await page.screenshot());
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

// ------------------------------------------------------------------ the web app (phone + GIF)

/** Serves the web export (SPA fallback), like `pnpm dev:web` but static. */
async function serveExport() {
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('No web export: run pnpm build:web (or pnpm build:desktop) first');
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/html' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Seeds the sample library through the app's own one-off migration from the old
 * localStorage store (apps/app/src/web/migrate.ts), plus settings.
 */
const seedScript = (settings) => `
  localStorage.setItem('margin.library.v1', ${JSON.stringify(
    JSON.stringify({ docs: Object.fromEntries(Object.entries(files).map(([p, content]) => [p, { content, modifiedAt: 1 }])), folders: ['Essays', 'Journal'] }),
  )});
  localStorage.setItem('margin.settings.v1', ${JSON.stringify(JSON.stringify({ welcomed: true, lastDocument: 'Essays/On margins.md', ...settings }))});
`;

async function webPage(browserType, contextOptions, settings) {
  const browser = await browserType.launch();
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(seedScript(settings));
  const page = await context.newPage();
  return { browser, page };
}

async function phoneShots(server) {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' };
  for (const [name, settings, act] of [
    [
      'iphone-library.png',
      {},
      async (page) => {
        await page.getByLabel('Back to the library').click();
        await page.getByTestId('library-row:Essays/On margins.md').waitFor();
      },
    ],
    ['iphone-editor.png', {}, async (page) => void (await caretIn('Margin is built around')(page))],
    ['iphone-focus.png', { focusMode: true, focusScope: 'sentence' }, async (page) => void (await caretIn('When you turn on focus mode')(page))],
  ]) {
    const { browser, page } = await webPage(webkit, phone, settings);
    try {
      await page.goto(server.url);
      await page.getByTestId('editor').waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => document.fonts.check("18px 'IBM Plex Mono'"));
      await act(page);
      await page.waitForTimeout(700);
      await savePng(name, await page.screenshot(), 780); // 1170 px wide @3x → 780 px (2x) keeps the weight down
    } finally {
      await browser.close();
    }
  }
}

/** ~5 s of typing in focus mode with typewriter scrolling, as an optimised GIF (ffmpeg palette). */
async function focusGif(server) {
  const frames = mkdtempSync(path.join(tmpdir(), 'margin-gif-'));
  const { browser, page } = await webPage(chromium, { viewport: { width: 960, height: 560 }, deviceScaleFactor: 1, colorScheme: 'light' }, { focusMode: true, focusScope: 'sentence', typewriter: true });
  try {
    await page.goto(server.url);
    await page.getByTestId('editor').waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => document.fonts.check("18px 'IBM Plex Mono'"));
    await caretIn('When you turn on focus mode')(page);
    await page.keyboard.press('ControlOrMeta+End'); // end of the document: start a new paragraph there
    await page.waitForTimeout(500);
    const text = '\n\nA new paragraph begins. The light follows the sentence you are in. Everything else rests in the margin.';
    let n = 0;
    const frame = async () => page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
    for (let i = 0; i < 6; i++) await frame(); // a beat before typing
    for (const [i, ch] of [...text].entries()) {
      await page.keyboard.type(ch);
      if (i % 2 === 1 || ch === '.') await frame(); // every other keystroke keeps the GIF short
    }
    for (let i = 0; i < 10; i++) await frame(); // a beat at the end
    // ~55 typed frames + holds at 12 fps ≈ 6 s.
    const gif = out('focus-mode.gif');
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(frames, 'f%04d.png'),
      '-vf', 'scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-loop', '0', gif,
    ]);
    written.push('focus-mode.gif');
  } finally {
    await browser.close();
    rmSync(frames, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ hero composition

/** "Mac + iPhone": the desktop screenshot in a plain window frame, the phone in a plain rounded frame. */
async function hero() {
  const dataUri = (name) => `data:image/png;base64,${readFileSync(out(name)).toString('base64')}`;
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const dark = theme === 'dark';
      const desk = dataUri(dark ? 'margin-dark.png' : 'margin-library.png');
      const phone = dataUri(dark ? 'iphone-focus.png' : 'iphone-editor.png');
      const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1.5 });
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div style="width:1280px;height:760px;position:relative;overflow:hidden;
          background:${dark ? 'radial-gradient(circle at 30% 20%,#2a2a2d,#141415 70%)' : 'radial-gradient(circle at 30% 20%,#ffffff,#e9e8e4 75%)'}">
          <div style="position:absolute;left:70px;top:56px;width:960px;border-radius:12px;overflow:hidden;
            box-shadow:0 30px 60px rgba(0,0,0,${dark ? 0.55 : 0.18}),0 0 0 1px rgba(${dark ? '255,255,255,.08' : '0,0,0,.08'});
            background:${dark ? '#1b1b1c' : '#fbfbfa'}">
            <div style="height:30px;display:flex;align-items:center;gap:8px;padding-left:14px;background:${dark ? '#232325' : '#f1f0ed'};
              border-bottom:1px solid ${dark ? '#2e2e30' : '#e2e1dd'}">
              ${['', '', ''].map(() => `<span style="width:11px;height:11px;border-radius:50%;background:${dark ? '#4a4a4d' : '#d3d2ce'}"></span>`).join('')}
            </div>
            <img src="${desk}" style="display:block;width:960px">
          </div>
          <div style="position:absolute;right:70px;bottom:40px;width:260px;padding:10px;border-radius:44px;
            background:${dark ? '#0c0c0d' : '#202022'};box-shadow:0 30px 60px rgba(0,0,0,${dark ? 0.6 : 0.3})">
            <img src="${phone}" style="display:block;width:260px;border-radius:34px">
          </div>
        </div></body></html>`);
      await page.waitForLoadState('load');
      const shot = await page.screenshot();
      writeFileSync(out(`hero-${theme}.webp`), await sharp(shot).resize({ width: 1600 }).webp({ quality: 88, effort: 6 }).toBuffer());
      written.push(`hero-${theme}.webp`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ run

if (only.includes('desktop')) {
  await desktopShot('margin-library.png', { sidebar: true }, caretIn('Margin is built around'));
  await desktopShot('margin-focus.png', { focusMode: true, focusScope: 'sentence', typewriter: true }, caretIn('When you turn on focus mode'));
  await desktopShot('margin-dark.png', { sidebar: false, dark: true }, caretIn('The blank space'));
}
if (only.includes('phone') || only.includes('gif')) {
  const server = await serveExport();
  try {
    if (only.includes('phone')) await phoneShots(server);
    if (only.includes('gif')) await focusGif(server);
  } finally {
    server.close();
  }
}
if (only.includes('hero')) await hero();

let total = 0;
for (const f of readdirSync(outDir)) total += statSync(out(f)).size;
for (const f of written) console.log(`docs/images/${f}  ${(statSync(out(f)).size / 1024).toFixed(0)} KB`);
console.log(`docs/images total: ${(total / 1024 / 1024).toFixed(2)} MB`);
