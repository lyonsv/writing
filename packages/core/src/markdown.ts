/** Lightweight markdown helpers. No parser dependency; good enough for titles and counts. */

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, '');
}

/** Strips inline markdown syntax (emphasis, code, links, images). */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}

/**
 * A document's title: the first ATX heading if there is one, otherwise the
 * first non-empty line, with markdown syntax removed. `null` for empty docs.
 */
export function extractTitle(markdown: string): string | null {
  const lines = stripFrontMatter(markdown).split(/\r?\n/);
  let firstLine: string | null = null;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) return stripInline(heading[2] ?? '') || null;
    if (firstLine === null && line.trim() !== '') firstLine = line;
  }
  if (firstLine === null) return null;
  return stripInline(firstLine.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '')) || null;
}

/** Plain prose text: front matter, code fences and block markers removed. */
export function toPlainText(markdown: string): string {
  return stripFrontMatter(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) => stripInline(line.replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, '')))
    .join('\n');
}

export function wordCount(markdown: string): number {
  const text = toPlainText(markdown);
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return words?.length ?? 0;
}

export function characterCount(markdown: string): number {
  return [...toPlainText(markdown).replace(/\s/g, '')].length;
}

/** Minutes to read at `wordsPerMinute`, rounded up; 0 for empty docs. */
export function readingMinutes(markdown: string, wordsPerMinute = 230): number {
  const words = wordCount(markdown);
  return words === 0 ? 0 : Math.ceil(words / wordsPerMinute);
}

/** Turns a title into a safe file name (no extension). */
export function fileNameFromTitle(title: string, fallback = 'Untitled'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\0]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}
