import { applyD1Migrations, type D1Migration, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(testEnv.DICT, testEnv.TEST_MIGRATIONS);
});
