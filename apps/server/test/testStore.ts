import { GitHubStore } from '../src/githubStore';
import { MemoryStore, type KeyValueStore } from '../src/store';
import { fakeGitHubContents } from './fakeGitHubContents';

/**
 * The store the suites run against. Default: MemoryStore. With
 * `MARGIN_TEST_STORE=github` (the `server-github` / `desktop-github` vitest
 * projects): the real `GitHubStore` on a faithful Contents API fake, with
 * random branch-head races (`MARGIN_TEST_RACE_RATE`, default 0.05) so the
 * retry path is exercised all the time (ADR 0021).
 */
export function testStore(): KeyValueStore {
  if (process.env.MARGIN_TEST_STORE === 'github') {
    const gh = fakeGitHubContents({ raceRate: Number(process.env.MARGIN_TEST_RACE_RATE ?? 0.05) });
    return new GitHubStore({ token: gh.token, repo: gh.repo, branch: gh.branch, fetch: gh.fetch, maxRaceRetries: 30 });
  }
  return new MemoryStore();
}
