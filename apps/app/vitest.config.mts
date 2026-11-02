import { defineConfig } from 'vitest/config';

// Node-only unit tests for the iOS storage, sync and sign-in logic (no React Native).
export default defineConfig({
  test: {
    name: 'app',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
