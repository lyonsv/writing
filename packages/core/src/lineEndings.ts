/**
 * Line-ending preservation. Editors (CodeMirror) normalise every line break to
 * `\n`; we remember what the file used and restore it on save, so a CRLF file
 * stays CRLF. Mixed files are written with their dominant ending.
 */
export type LineEnding = '\n' | '\r\n' | '\r';

/** The dominant line ending in `text` (`\n` when there are none). */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}

/** Converts `\n`-normalised editor text to `eol`. */
export function withLineEnding(text: string, eol: LineEnding): string {
  if (eol === '\n') return text;
  return text.replace(/\r\n|\r|\n/g, eol);
}
