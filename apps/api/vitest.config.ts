import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./fixtures'),
          APP_MIGRATIONS: await readD1Migrations('./drizzle'),
          BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters-long',
        },
      },
    })),
  ],
  test: {
    include: ['./test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
