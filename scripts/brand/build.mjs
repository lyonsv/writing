#!/usr/bin/env node
/**
 * Margin brand assets, generated reproducibly (ADR 0018). `pnpm brand:build`
 * writes every SVG and PNG/ICNS from the geometry below; `pnpm brand:check`
 * regenerates in memory and fails if a committed file differs.
 *
 * The mark: a page with a margin rule, three lines of text with only the
 * middle one at full strength (focus mode), and the caret after it.
 * The wordmark: "Margin" in IBM Plex Mono Medium, converted to outlines so
 * the SVGs don't depend on an installed font.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = process.argv.includes('--check');

const C = {
  paper: '#fbfbfa',
  ink: '#1f1f1f',
  muted: '#a3a3a0',
  accent: '#1a8fc7',
  night: '#1b1b1c',
  inkDark: '#d9d9d6',
  mutedDark: '#6b6b68',
  accentDark: '#4fb3e6',
};

// ------------------------------------------------------------------ geometry (1024 grid)

/** The glyph, drawn in a 1024×1024 box. Colours: rule, ink (text lines), accent (caret). */
function glyph({ rule, ink, accent, dim = 0.3 }) {
  return [
    `<rect x="300" y="262" width="24" height="500" rx="12" fill="${rule}"/>`,
    `<rect x="392" y="372" width="336" height="40" rx="20" fill="${ink}" fill-opacity="${dim}"/>`,
    `<rect x="392" y="492" width="288" height="40" rx="20" fill="${ink}"/>`,
    `<rect x="704" y="462" width="22" height="100" rx="11" fill="${accent}"/>`,
    `<rect x="392" y="612" width="232" height="40" rx="20" fill="${ink}" fill-opacity="${dim}"/>`,
  ].join('');
}

const LIGHT = { rule: C.muted, ink: C.ink, accent: C.accent };
const DARK = { rule: C.mutedDark, ink: C.inkDark, accent: C.accentDark };
const MONO = { rule: '#000', ink: '#000', accent: '#000', dim: 0.35 };

const svg = (w, h, body, title = 'Margin') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

/** macOS: a 824×824 rounded square on the 1024 canvas (Apple's icon grid), with the system-style shadow. */
function macIcon() {
  const defs =
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f1ee"/></linearGradient>` +
    `<filter id="s" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/></filter></defs>`;
  const tile = `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)" filter="url(#s)"/>`;
  return svg(1024, 1024, `${defs}${tile}<g transform="translate(100 100) scale(${824 / 1024})">${glyph(LIGHT)}</g>`);
}

/** iOS: full-bleed squares (iOS applies the mask). Dark and tinted use a transparent background, per Apple. */
const iosLight = () => svg(1024, 1024, `<rect width="1024" height="1024" fill="${C.paper}"/>${glyph(LIGHT)}`);
const iosDark = () => svg(1024, 1024, glyph(DARK));
const iosTinted = () => svg(1024, 1024, glyph({ rule: '#8a8a8a', ink: '#ffffff', accent: '#ffffff', dim: 0.45 }));

// ------------------------------------------------------------------ wordmark

function loadFont() {
  const file = path.join(root, 'apps/app/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff');
  const buf = readFileSync(file);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function wordmark(font, colors) {
  const size = 220;
  const text = font.getPath('Margin', 0, 0, size);
  const d = text.toPathData(2);
  const bb = text.getBoundingBox(); // y1 < 0 above the baseline, y2 > 0 below
  const xHeight = font.tables.os2?.sxHeight ? (font.tables.os2.sxHeight / font.unitsPerEm) * size : size * 0.52;
  // The mark cropped to its drawn content (x 300–728, y 262–762 in the 1024 grid),
  // scaled to about the cap height, its middle line level with the x-height band.
  const s = (size * 0.86) / 500;
  const pad = 8;
  const markW = (728 - 300) * s;
  const gap = size * 0.32;
  const markCentreFromBaseline = -xHeight / 2;
  const markTopRel = markCentreFromBaseline - 250 * s;
  const top = Math.min(markTopRel, bb.y1);
  const bottom = Math.max(markTopRel + 500 * s, bb.y2);
  const baseline = pad - top;
  const textX = pad + markW + gap - bb.x1;
  const width = Math.ceil(textX + bb.x2 + pad);
  const height = Math.ceil(bottom - top + 2 * pad);
  const markY = baseline + markTopRel;
  const body =
    `<g transform="translate(${(pad - 300 * s).toFixed(2)} ${(markY - 262 * s).toFixed(2)}) scale(${s.toFixed(5)})">${glyph(colors)}</g>` +
    `<path transform="translate(${textX.toFixed(2)} ${baseline.toFixed(2)})" fill="${colors.ink}" d="${d}"/>`;
  return svg(width, height, body);
}

// ------------------------------------------------------------------ raster + icns

function png(svgText, size, background) {
  const r = new Resvg(svgText, { fitTo: { mode: 'width', value: size }, background, font: { loadSystemFonts: false } });
  return r.render().asPng();
}

/** Apple ICNS: 'icns' + length, then (type, length, PNG) entries. */
function icns(svgText) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = types.map(([type, size]) => {
    const data = png(svgText, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------ outputs

const font = loadFont();
const brand = (f) => path.join(root, 'assets/brand', f);
const app = (f) => path.join(root, 'apps/app', f);
const outputs = [
  [brand('mark-light.svg'), svg(1024, 1024, glyph(LIGHT))],
  [brand('mark-dark.svg'), svg(1024, 1024, glyph(DARK))],
  [brand('mark-mono.svg'), svg(1024, 1024, glyph(MONO))],
  [brand('wordmark-light.svg'), wordmark(font, LIGHT)],
  [brand('wordmark-dark.svg'), wordmark(font, DARK)],
  [brand('wordmark-mono.svg'), wordmark(font, MONO)],
  [brand('icon-macos.svg'), macIcon()],
  [brand('icon-ios-light.svg'), iosLight()],
  [brand('icon-ios-dark.svg'), iosDark()],
  [brand('icon-ios-tinted.svg'), iosTinted()],
];
const byName = Object.fromEntries(outputs.map(([p, s]) => [path.basename(p), s]));
outputs.push(
  [path.join(root, 'apps/desktop/build/icon.icns'), icns(byName['icon-macos.svg'])],
  [path.join(root, 'apps/desktop/build/icon.png'), png(byName['icon-macos.svg'], 1024)],
  [app('assets/icon.png'), png(byName['icon-ios-light.svg'], 1024)],
  [app('assets/icon-dark.png'), png(byName['icon-ios-dark.svg'], 1024)],
  [app('assets/icon-tinted.png'), png(byName['icon-ios-tinted.svg'], 1024)],
  [app('assets/splash-icon.png'), png(byName['mark-light.svg'], 512)],
  [app('assets/splash-icon-dark.png'), png(byName['mark-dark.svg'], 512)],
  [app('assets/favicon.png'), png(byName['icon-ios-light.svg'], 48)],
  [app('public/apple-touch-icon.png'), png(byName['icon-ios-light.svg'], 180)],
  [app('public/favicon.svg'), byName['icon-ios-light.svg']],
  // Web app manifest (ADR 0020): full-bleed squares; "maskable" keeps the glyph inside the safe zone.
  [app('public/icon-192.png'), png(byName['icon-ios-light.svg'], 192)],
  [app('public/icon-512.png'), png(byName['icon-ios-light.svg'], 512)],
  [app('public/icon-maskable-512.png'), png(svg(1024, 1024, `<rect width="1024" height="1024" fill="${C.paper}"/><g transform="translate(102.4 102.4) scale(0.8)">${glyph(LIGHT)}</g>`), 512)],
);

let stale = 0;
for (const [file, content] of outputs) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (CHECK) {
    if (!existsSync(file) || !readFileSync(file).equals(bytes)) {
      console.error(`stale: ${path.relative(root, file)}`);
      stale++;
    }
    continue;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${path.relative(root, file)} (${bytes.length} bytes)`);
}
if (CHECK) {
  if (stale) {
    console.error(`${stale} brand file(s) out of date: run pnpm brand:build`);
    process.exit(1);
  }
  console.log(`brand assets up to date (${outputs.length} files)`);
}
