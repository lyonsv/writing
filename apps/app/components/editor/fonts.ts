/* eslint-disable @typescript-eslint/no-require-imports */
// Metro does not rewrite url() inside imported CSS, so @fontsource's CSS files
// would reference font files that never get exported. Instead we require the
// woff2 files as Metro assets (which are copied into the export) and inject
// our own @font-face rules with the resolved URLs. Latin subset only.
const FILES = {
  '400-normal': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'),
  '400-italic': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2'),
  '700-normal': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2'),
  '700-italic': require('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-italic.woff2'),
} as const;

export function fontAssetUrl(asset: unknown): string {
  if (typeof asset === 'string') return asset;
  if (asset && typeof asset === 'object') {
    const a = asset as { uri?: unknown; default?: unknown };
    if (typeof a.uri === 'string') return a.uri;
    if (typeof a.default === 'string') return a.default;
  }
  return String(asset);
}

export function fontFaceCss(): string {
  return Object.entries(FILES)
    .map(([key, asset]) => {
      const [weight, style] = key.split('-');
      return `@font-face{font-family:'IBM Plex Mono';font-style:${style};font-weight:${weight};font-display:block;src:url(${JSON.stringify(fontAssetUrl(asset))}) format('woff2');}`;
    })
    .join('\n');
}

