import type { Config } from './config.js';
import type { Identity } from './devices.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {}

/** GitHub authorize URL (OAuth App, PKCE S256, no scopes: we only read the public profile). */
export function authorizeUrl(config: Config, state: string, challenge: string): string {
  const u = new URL('/login/oauth/authorize', config.githubOAuthUrl);
  u.searchParams.set('client_id', config.githubClientId);
  u.searchParams.set('redirect_uri', callbackUrl(config));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

export function callbackUrl(config: Config): string {
  return new URL('/api/auth/github/callback', config.publicUrl).toString();
}

/**
 * Exchanges the authorization code for a GitHub access token, reads the
 * user's id and login with it, and drops it. The GitHub token never leaves
 * this function: it isn't stored, logged or returned.
 */
export async function fetchGitHubIdentity(
  config: Config,
  fetchImpl: Fetch,
  code: string,
  verifier: string,
): Promise<Identity> {
  const tokenRes = await fetchImpl(new URL('/login/oauth/access_token', config.githubOAuthUrl).toString(), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Margin' },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: callbackUrl(config),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new GitHubError(`token endpoint HTTP ${tokenRes.status}`);
  // GitHub reports errors (bad code, bad verifier) as 200 with an `error` field.
  const tokenBody = (await tokenRes.json()) as { access_token?: unknown; error?: unknown };
  if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) {
    throw new GitHubError(`token endpoint error ${typeof tokenBody.error === 'string' ? tokenBody.error : 'unknown'}`);
  }
  const userRes = await fetchImpl(new URL('/user', config.githubApiUrl).toString(), {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenBody.access_token}`,
      'User-Agent': 'Margin',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new GitHubError(`user endpoint HTTP ${userRes.status}`);
  const user = (await userRes.json()) as { id?: unknown; login?: unknown };
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || typeof user.login !== 'string') {
    throw new GitHubError('user endpoint returned an unexpected shape');
  }
  return { githubId: user.id, login: user.login.toLowerCase() };
}
