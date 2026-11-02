import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
