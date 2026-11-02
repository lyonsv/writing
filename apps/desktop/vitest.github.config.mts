import { defineConfig } from 'vitest/config';

/** The two-device sync and sign-in suites against a server on GitHubStore + the Contents API fake (ADR 0021). */
export default defineConfig({
  test: {
    name: 'desktop-github',
    include: ['test/sync.test.ts', 'test/account.test.ts'],
    environment: 'node',
    env: { MARGIN_TEST_STORE: 'github' },
    testTimeout: 30_000,
  },
});
