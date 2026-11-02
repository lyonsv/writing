import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp, type AppDeps } from '../src/createApp';
import type { Config } from '../src/config';
import { listen } from '../src/local';
import { testStore } from './testStore';

/**
 * Test support for full round trips over real HTTP (desktop integration tests
 * and the Electron e2e): a mock GitHub OAuth server, a local Margin server
 * wired to it, and a tiny "system browser" that follows redirects with a
 * cookie jar. Not used in production code.
 */

export interface GitHubUser {
  id: number;
  login: string;
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });

/** Mock GitHub: `authorize` auto-approves as `user` (or denies if `deny`), and checks PKCE at the token endpoint. */
export async function startMockGitHub(initial: GitHubUser) {
  const state = { user: initial, deny: false };
  const codes = new Map<string, { user: GitHubUser; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, GitHubUser>();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        if (state.deny) redirect.searchParams.set('error', 'access_denied');
        else {
          const code = randomBytes(10).toString('hex');
          codes.set(code, { user: state.user, challenge: url.searchParams.get('code_challenge')!, redirectUri: redirect.origin + redirect.pathname });
          redirect.searchParams.set('code', code);
        }
        res.writeHead(302, { Location: redirect.toString() }).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const b = JSON.parse(await body(req)) as Record<string, string>;
        const entry = codes.get(b.code!);
        codes.delete(b.code!);
        res.setHeader('Content-Type', 'application/json');
        if (!entry || b.redirect_uri !== entry.redirectUri || s256(b.code_verifier ?? '') !== entry.challenge || b.client_secret !== 'secret') {
          res.end(JSON.stringify({ error: 'bad_verification_code' }));
          return;
        }
        const token = `gho_${randomBytes(12).toString('hex')}`;
        tokens.set(token, entry.user);
        res.end(JSON.stringify({ access_token: token, token_type: 'bearer' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/user') {
        const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(user ?? { message: 'Bad credentials' }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** A Margin server (in-memory store) talking to the mock GitHub. */
export async function startTestServer(
  github: { url: string },
  allowed: GitHubUser,
  extra: Partial<Config> = {},
  options: { web?: AppDeps['web'] } = {},
) {
  let config: Config | undefined;
  const store = testStore();
  const app = createApp({ config: () => config!, store, log: () => {}, web: options.web });
  const server = await listen(app);
  config = {
    publicUrl: new URL(server.url),
    githubClientId: 'id',
    githubClientSecret: 'secret',
    allowedUsers: [{ login: allowed.login.toLowerCase(), id: allowed.id }],
    authSecret: 'e2e-secret-'.repeat(4),
    githubOAuthUrl: github.url,
    githubApiUrl: github.url,
    secureCookies: false,
    ...extra,
  };
  return { url: server.url, store, app, close: server.close };
}

/**
 * Plays the system browser: follows redirects from `startUrl` (keeping
 * cookies) until it lands on a non-redirect response, e.g. the app's loopback
 * page. Returns every URL visited and the final page's text.
 */
export async function browse(
  startUrl: string,
  opts: { stopAt?: string; maxHops?: number; decision?: 'continue' | 'cancel' } = {},
): Promise<{ visited: string[]; status: number; text: string; stoppedAt?: string }> {
  const maxHops = opts.maxHops ?? 10;
  const jar = new Map<string, string>();
  const visited: string[] = [];
  let url = startUrl;
  let form: { csrf: string } | null = null;
  for (let i = 0; i < maxHops; i++) {
    visited.push(url);
    const origin = new URL(url).origin;
    const cookie = jar.get(origin);
    const res = form
      ? await fetch(url, {
          method: 'POST',
          redirect: 'manual',
          headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf: form.csrf, decision: opts.decision ?? 'continue' }).toString(),
        })
      : await fetch(url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    form = null;
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0]!;
      const existing = new Map((jar.get(origin) ?? '').split('; ').filter(Boolean).map((p) => [p.split('=')[0]!, p] as const));
      existing.set(pair.split('=')[0]!, pair);
      jar.set(origin, [...existing.values()].filter((p) => !p.endsWith('=')).join('; '));
    }
    const location = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      if (opts.stopAt && url.startsWith(opts.stopAt)) return { visited, status: res.status, text: '', stoppedAt: url };
      continue;
    }
    const text = await res.text();
    // The server's "Sign in a new device?" page: press the button, like the user would.
    const confirm = /<form id="margin-confirm"[^>]*action="([^"]+)"[\s\S]*?name="csrf" value="([^"]+)"/.exec(text);
    if (res.status === 200 && confirm) {
      form = { csrf: confirm[2]! };
      url = new URL(confirm[1]!, url).toString();
      continue;
    }
    return { visited, status: res.status, text };
  }
  throw new Error('too many redirects');
}

/** Signs in a second "device" directly over HTTP (no app): returns its token and device id. */
export async function signInDevice(serverUrl: string, name: string): Promise<{ token: string; id: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const redirect = 'http://127.0.0.1:9999/callback'; // never fetched: browse stops there
  const start = new URL('/api/auth/native/start', serverUrl);
  start.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: s256(verifier), code_challenge_method: 'S256', state: 'second-device-state' }).toString();
  const { stoppedAt } = await browse(start.toString(), { stopAt: redirect });
  const code = new URL(stoppedAt!).searchParams.get('code');
  const res = await fetch(new URL('/api/auth/native/token', serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect, device_name: name }),
  });
  const json = (await res.json()) as { token: string; device: { id: string } };
  return { token: json.token, id: json.device.id };
}
