import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // *-github: the same suites on the GitHub storage backend (Contents API fake), ADR 0021.
    projects: ['packages/*', 'apps/app', 'apps/desktop', 'apps/server', 'apps/server/vitest.github.config.mts', 'apps/desktop/vitest.github.config.mts'],
  },
});
