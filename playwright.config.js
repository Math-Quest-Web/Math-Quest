// Playwright runs the game in a real browser. Locally set PW_CHANNEL=chrome to reuse an installed
// Chrome; in CI the workflow installs Chromium. Firebase is replaced by an in-memory stub
// (tests/support/firebase-stub.js), so no test ever talks to the live project.
const { defineConfig } = require('@playwright/test');

// PORT can be overridden so several checkouts (or a running dev server) never collide.
const PORT = Number(process.env.PORT) || 4173;

module.exports = defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node tests/support/serve.js',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI
  }
});
