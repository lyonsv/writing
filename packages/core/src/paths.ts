/**
 * Document paths are POSIX-style paths relative to the library root,
 * e.g. `notes/ideas/draft.md`. They never start with `/`, never contain
 * `.` or `..` segments, and never contain backslashes or NUL bytes.
 *
 * Every storage adapter (and the Electron main process) must run untrusted
 * paths through `normalizeDocPath` before touching storage.
 */

export class InvalidPathError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Invalid document path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

export const MARKDOWN_EXTENSION = '.md';

/**
 * Validates and normalises a library-relative path. Collapses duplicate and
 * trailing slashes. Throws `InvalidPathError` for anything that could escape
 * the library root. The empty string (the root itself) is allowed only when
 * `allowRoot` is true.
 */
export function normalizeDocPath(input: string, options: { allowRoot?: boolean } = {}): string {
  if (typeof input !== 'string') {
    throw new InvalidPathError(String(input), 'not a string');
  }
  if (input.includes('\0')) throw new InvalidPathError(input, 'contains NUL byte');
  if (input.includes('\\')) throw new InvalidPathError(input, 'contains backslash');
  if (input.startsWith('/')) throw new InvalidPathError(input, 'must be relative');
  if (/^[a-zA-Z]:/.test(input)) throw new InvalidPathError(input, 'must be relative');

  const segments = input.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new InvalidPathError(input, 'contains relative segment');
    }
  }
  const normalized = segments.join('/');
  if (normalized === '' && !options.allowRoot) {
    throw new InvalidPathError(input, 'is empty');
  }
  return normalized;
}

export function joinDocPath(...parts: string[]): string {
  return normalizeDocPath(parts.filter((p) => p.length > 0).join('/'), { allowRoot: true });
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

export function ensureMarkdownExtension(path: string): string {
  return isMarkdownPath(path) ? path : `${path}${MARKDOWN_EXTENSION}`;
}

/** Display name: the file name without its `.md` extension. */
export function displayName(path: string): string {
  const name = basename(path);
  return isMarkdownPath(name) ? name.slice(0, -MARKDOWN_EXTENSION.length) : name;
}

/** True if `child` equals `parent` or is nested inside it. */
export function isWithin(parent: string, child: string): boolean {
  if (parent === '') return true;
  return child === parent || child.startsWith(`${parent}/`);
}

/** True if any segment starts with `.` (hidden files and folders). */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}
