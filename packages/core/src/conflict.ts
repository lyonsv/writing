import { MARKDOWN_EXTENSION, dirname, basename, isMarkdownPath, joinDocPath } from './paths';

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HHMM` in local time. */
export function conflictTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Path for a "keep both" conflict copy:
 * `notes/Draft.md` → `notes/Draft (conflict 2026-11-02 1430).md`.
 * `attempt` > 1 appends a counter for when that name is already taken:
 * `notes/Draft (conflict 2026-11-02 1430 2).md`.
 *
 * Shared by the desktop save pipeline and (M5) sync.
 */
export function conflictCopyPath(path: string, date: Date, attempt = 1): string {
  const name = basename(path);
  const stem = isMarkdownPath(name) ? name.slice(0, -MARKDOWN_EXTENSION.length) : name;
  const suffix = attempt > 1 ? ` ${attempt}` : '';
  return joinDocPath(dirname(path), `${stem} (conflict ${conflictTimestamp(date)}${suffix})${MARKDOWN_EXTENSION}`);
}

const CONFLICT_RE = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)\.md$/i;

export function isConflictCopy(path: string): boolean {
  return CONFLICT_RE.test(path);
}
