/**
 * Byte helpers with no DOM or Node globals (core runs in Hermes on iOS, where
 * `TextDecoder` and `atob`/`btoa` aren't guaranteed). Used by the iOS file
 * store and its sync adapter; tests compare them with Node's implementations.
 */

/** UTF-8 bytes of `text`. Lone surrogates become U+FFFD, like `TextEncoder`. */
export function encodeUtf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else cp = 0xfffd;
    } else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out[n++] = cp;
    else if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
      out[n++] = 0x80 | (cp & 63);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 63);
      out[n++] = 0x80 | (cp & 63);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 63);
      out[n++] = 0x80 | ((cp >> 6) & 63);
      out[n++] = 0x80 | (cp & 63);
    }
  }
  return out.slice(0, n);
}

/**
 * Strict UTF-8 decode: returns null for anything that isn't well-formed UTF-8
 * (overlongs, surrogates, out-of-range, truncated sequences). A leading BOM is
 * kept as U+FEFF so the text writes back byte-identical (ADR 0006 amendments).
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  const parts: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    parts.push(String.fromCharCode(...chunk));
    chunk = [];
  };
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) {
      cp = b0;
      need = 0;
      min = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      need = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      need = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      need = 3;
      min = 0x10000;
    } else return null;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    i += need + 1;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length >= 8192) flush();
  }
  flush();
  return parts.join('');
}

/** Latin-1 view of bytes (one char per byte): shows a non-UTF-8 file read-only without loss. */
export function decodeLatin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return parts.join('');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
    if (chunk.length >= 16384) {
      parts.push(chunk);
      chunk = '';
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    chunk += `${B64[n >> 18]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    chunk += `${B64[n >> 18]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  parts.push(chunk);
  return parts.join('');
}

/** Decodes standard base64 (padding optional, whitespace ignored). Throws on other characters. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (const c of clean) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error('invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, n);
}

/** Lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}
