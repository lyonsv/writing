import { defineConfig } from 'vitest/config';

/** The server suites again, with GitHubStore on the Contents API fake (ADR 0021). */
export default defineConfig({
  test: {
    name: 'server-github',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { MARGIN_TEST_STORE: 'github' },
    testTimeout: 20_000,
  },
});
