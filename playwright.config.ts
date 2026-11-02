import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    // The Electron desktop app (built): e2e/*.spec.ts.
    { name: 'desktop', testIgnore: /web\// },
    // The hosted web app on an iPhone-sized WebKit (ADR 0020): e2e/web/*.spec.ts against a local
    // server serving the built web export (`pnpm build:web`) with a mock GitHub.
    { name: 'web-iphone', testMatch: /web\/.*\.spec\.ts/, use: { ...devices['iPhone 15'], browserName: 'webkit' } },
  ],
});
