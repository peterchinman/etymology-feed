import { defineConfig } from '@playwright/test';

const origin = `http://127.0.0.1:${process.env.ETYMOLOGY_E2E_PORT ?? '8787'}`;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // Expose intermittent failures; retained traces make a rerun unnecessary for diagnosis.
  retries: 0,
  outputDir: decodeURIComponent(
    new URL('./test-results', import.meta.url).pathname,
  ),
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: origin,
    // Tests start past the first-run welcome card; welcome.spec.ts clears this.
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [{ name: 'etymology-welcome', value: 'done' }],
        },
      ],
    },
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: 'node scripts/start-e2e.mjs',
    cwd: decodeURIComponent(new URL('.', import.meta.url).pathname),
    url: `${origin}/healthz`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
