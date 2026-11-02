/**
 * Server configuration from environment variables. Parsing fails closed: a
 * missing or malformed value throws, and the app then answers every request
 * with a generic 500 instead of running half-configured. Every variable is
 * listed in the repo's `.env.example`.
 */

export interface AllowedUser {
  /** Compared case-insensitively (GitHub logins are case-insensitive). */
  login: string;
  /** GitHub's immutable numeric user id. */
  id: number;
}

export interface Config {
  /** This server's own origin, e.g. `https://margin.example.com` (no trailing slash, no path). */
  publicUrl: URL;
  githubClientId: string;
  githubClientSecret: string;
  allowedUsers: AllowedUser[];
  /** 32+ byte key material for sealing the short-lived OAuth state cookie. */
  authSecret: string;
  /** Overridable only so tests can point at a mock GitHub. */
  githubOAuthUrl: string;
  githubApiUrl: string;
  /** Session cookies get `Secure` and the `__Host-` prefix unless the public URL is plain-http loopback. */
  secureCookies: boolean;
}

export class ConfigError extends Error {}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `ALLOWED_GITHUB_LOGINS` is a comma-separated list of `login:id` pairs, e.g.
 * `lyonsv:1234567`. Both must match at sign-in, so a renamed account (same id,
 * new login) or a recycled username (same login, new id) is refused until the
 * owner updates the variable. Find your id with
 * `curl -s https://api.github.com/users/<login> | grep '"id"'`.
 */
export function parseAllowedUsers(raw: string | undefined): AllowedUser[] {
  if (!raw || !raw.trim()) throw new ConfigError('ALLOWED_GITHUB_LOGINS is empty');
  return raw.split(',').map((entry) => {
    const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})):(\d{1,15})\s*$/.exec(entry);
    if (!m) throw new ConfigError('ALLOWED_GITHUB_LOGINS entries must look like login:numericId');
    const id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ConfigError('ALLOWED_GITHUB_LOGINS has a bad id');
    return { login: m[1]!.toLowerCase(), id };
  });
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is not set`);
  return v;
}

function httpsOrLoopback(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new ConfigError(`${name} must be https (or http on localhost)`);
  return url;
}

/**
 * `PUBLIC_URL`, or, on a Vercel **preview** deployment only, `https://$VERCEL_URL`
 * (the deployment's own URL, set by Vercel). Production never falls back: it
 * must be configured (`https://margin-sync.vercel.app`), so a missing value
 * fails closed. GitHub sign-in on a preview additionally needs an OAuth App
 * whose callback matches that URL (docs/server-setup.md).
 */
function publicUrlFrom(env: Record<string, string | undefined>): string {
  const explicit = env.PUBLIC_URL?.trim();
  if (explicit) return explicit;
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_URL && /^[a-z0-9.-]+$/i.test(env.VERCEL_URL)) return `https://${env.VERCEL_URL}`;
  throw new ConfigError('PUBLIC_URL is not set');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const publicUrl = httpsOrLoopback(publicUrlFrom(env), 'PUBLIC_URL');
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username) {
    throw new ConfigError('PUBLIC_URL must be an origin only, e.g. https://margin.example.com');
  }
  const authSecret = required(env, 'AUTH_SECRET');
  if (authSecret.length < 32) throw new ConfigError('AUTH_SECRET must be at least 32 characters');
  const githubOAuthUrl = httpsOrLoopback(env.GITHUB_OAUTH_URL?.trim() || 'https://github.com', 'GITHUB_OAUTH_URL');
  const githubApiUrl = httpsOrLoopback(env.GITHUB_API_URL?.trim() || 'https://api.github.com', 'GITHUB_API_URL');
  return {
    publicUrl,
    githubClientId: required(env, 'GITHUB_CLIENT_ID'),
    githubClientSecret: required(env, 'GITHUB_CLIENT_SECRET'),
    allowedUsers: parseAllowedUsers(env.ALLOWED_GITHUB_LOGINS),
    authSecret,
    githubOAuthUrl: githubOAuthUrl.origin,
    githubApiUrl: githubApiUrl.origin,
    secureCookies: publicUrl.protocol === 'https:',
  };
}

export function isAllowed(users: readonly AllowedUser[], login: string, id: number): boolean {
  const l = login.toLowerCase();
  return users.some((u) => u.id === id && u.login === l);
}
