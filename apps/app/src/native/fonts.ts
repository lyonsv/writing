/* eslint-disable @typescript-eslint/no-require-imports */
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

/**
 * IBM Plex Mono for the editor's WebView on iOS (ADR 0016).
 *
 * The DOM component references its woff2 files by a bare relative URL
 * (`<hash>.woff2`), but `expo export` puts the files under `assets/`, not next to
 * the DOM bundle's HTML in `www.bundle/`, so in an exported/embedded build the
 * WebView would silently fall back to a system monospace font. Instead the
 * native side resolves the same assets (Expo Go: from the dev server;
 * builds: from the app bundle), reads them, and hands the editor `@font-face`
 * rules with data: URIs (~85 KB of base64, once per editor mount).
 */
const FILES = {
  '400-normal': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'),
  '400-italic': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2'),
  '700-normal': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2'),
  '700-italic': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-italic.woff2'),
} as const;

let cached: Promise<string> | null = null;

export function inlineFontCss(): Promise<string> {
  cached ??= (async () => {
    const rules: string[] = [];
    for (const [key, mod] of Object.entries(FILES)) {
      const [weight, style] = key.split('-');
      const asset = Asset.fromModule(mod as number);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error(`font asset ${key} has no local file`);
      const b64 = await new File(asset.localUri).base64();
      rules.push(
        `@font-face{font-family:'IBM Plex Mono';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
      );
    }
    return rules.join('\n');
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
