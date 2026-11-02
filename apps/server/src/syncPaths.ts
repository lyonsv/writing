/**
 * Sync path rules, the server's copy of `isSyncablePath` in @margin/core (the
 * server takes only types from core at runtime; a test checks the two agree on
 * a large corpus). A synced path is the canonical form of a library path:
 * relative, `/`-separated, no empty / `.` / `..` / hidden segments, no
 * backslash, NUL or control characters, ends in `.md` (any case), Unicode NFC,
 * every name ≤ 255 UTF-8 bytes and the whole path ≤ 1024 bytes.
 */
export const MAX_NAME_BYTES = 255;
export const MAX_PATH_BYTES = 1024;

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

export function isSyncPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.normalize('NFC') !== path) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  if (utf8(path) > MAX_PATH_BYTES || !path.toLowerCase().endsWith('.md')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.') && utf8(seg) <= MAX_NAME_BYTES);
}
