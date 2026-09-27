import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.ETYMOLOGY_E2E_PORT ?? '8787'}`,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: 'node scripts/start-e2e.mjs',
    cwd: decodeURIComponent(new URL('.', import.meta.url).pathname),
    url: `http://127.0.0.1:${process.env.ETYMOLOGY_E2E_PORT ?? '8787'}/healthz`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
