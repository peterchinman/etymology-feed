import { applyD1Migrations, type D1Migration, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const testEnv = env as Cloudflare.Env & {
    TEST_MIGRATIONS: D1Migration[];
    APP_MIGRATIONS: D1Migration[];
  };
  await applyD1Migrations(testEnv.DICT, testEnv.TEST_MIGRATIONS);
  await applyD1Migrations(testEnv.APP, testEnv.APP_MIGRATIONS);
  const words = await testEnv.DICT.prepare('SELECT word,prior FROM word').all<{
    word: string;
    prior: number;
  }>();
  for (let i = 0; i < words.results.length; i += 100) {
    await testEnv.APP.batch(
      words.results
        .slice(i, i + 100)
        .map(({ word, prior }) =>
          testEnv.APP.prepare(
            'INSERT INTO word_stats (word,likes,dislikes,prior,score,updated_at) VALUES (?,0,0,?,?,0)',
          ).bind(word, prior, prior),
        ),
    );
  }
});
