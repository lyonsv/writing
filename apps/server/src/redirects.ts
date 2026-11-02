/**
 * Same value as `NATIVE_CUSTOM_SCHEME_REDIRECT` in @margin/core (a test checks it).
 * Not imported: the server only takes *types* from core at runtime, because
 * core ships raw TS that the Vercel Node builder isn't guaranteed to compile.
 */
export const CUSTOM_SCHEME_REDIRECT = 'margin://auth/callback';

/**
 * Redirect-target allowlists. The server only ever redirects to:
 * - GitHub's authorize URL (built from config),
 * - a native app redirect accepted by `isAllowedNativeRedirect`,
 * - a same-origin path accepted by `safeReturnPath`.
 * Anything else is refused with a 400 page, never redirected.
 */

/**
 * RFC 8252 native redirects: the loopback IP literal on any ephemeral port
 * with the fixed path `/callback` (desktop, §7.3), or the app's custom scheme
 * (iOS, §7.1). `localhost` is refused (§8.3: it can resolve elsewhere); so is
 * anything with a query, fragment, credentials or another path. Exact regexes,
 * not URL parsing, so there's no normalisation to trick.
 */
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{3,4})\/callback$/;

export function isAllowedNativeRedirect(uri: string): boolean {
  if (uri === CUSTOM_SCHEME_REDIRECT) return true;
  const m = LOOPBACK.exec(uri);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535;
}

/**
 * Where the hosted web build lands after signing in: a path on this origin.
 * Refuses absolute URLs, scheme-relative `//host`, backslash tricks (`/\host`,
 * which browsers treat as `//host`), control characters, and anything that
 * resolves to another origin.
 */
export function safeReturnPath(raw: string | undefined, origin: URL): string {
  if (!raw) return '/';
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000- \u007f]/.test(raw)) {
    return '/';
  }
  try {
    const resolved = new URL(raw, origin);
    if (resolved.origin !== origin.origin) return '/';
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return '/';
  }
}
