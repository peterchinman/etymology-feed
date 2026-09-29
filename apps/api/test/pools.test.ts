import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { buildPools } from '../src/pools';

beforeEach(async () => {
  await env.APP.prepare('DELETE FROM word_stats').run();
});

it('uses random ties before every pool cutoff instead of alphabetical card IDs', async () => {
  // A fixed permutation makes this regression deterministic. In production the
  // database assigns independent random keys, including to newly seeded cards.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `${i < 30 ? '-suffix' : 'word'}-${i}`,
    order: String((i * 17) % 60).padStart(2, '0'),
  }));
  await env.APP.batch(
    rows.map(({ id, order }) =>
      env.APP.prepare(
        'INSERT INTO word_stats (card_id,likes,dislikes,prior,score,updated_at,pool_order) VALUES (?,0,0,0.8,0.5,0,?)',
      ).bind(id, order),
    ),
  );
  const expected = [...rows]
    .sort((a, b) => a.order.localeCompare(b.order))
    .slice(0, 12)
    .map(({ id }) => id);
  const bindings = {
    ...env,
    FRESH_POOL_SIZE: 12,
    CONFIRMED_POOL_SIZE: 12,
    PROMISING_POOL_SIZE: 12,
  };
  expect((await buildPools(bindings)).fresh).toEqual(expected);
  expect(expected.some((id) => id.startsWith('-suffix'))).toBe(true);
  expect(expected.some((id) => id.startsWith('word'))).toBe(true);

  await env.APP.prepare('UPDATE word_stats SET likes=1,score=0.667').run();
  expect((await buildPools(bindings)).promising.map(([id]) => id)).toEqual(
    expected,
  );
  await env.APP.prepare('UPDATE word_stats SET likes=5,score=0.857').run();
  expect((await buildPools(bindings)).confirmed.map(([id]) => id)).toEqual(
    expected,
  );
});

it('keeps fewest looks and highest priority ahead of the random tie-breaker', async () => {
  await env.APP.prepare(
    `INSERT INTO word_stats (card_id,likes,dislikes,prior,score,updated_at,pool_order) VALUES
    ('unseen-high',0,0,0.8,0.5,0,'z'),
    ('unseen-low',0,0,0.2,0.5,0,'a'),
    ('seen-high',0,1,0.8,0.444,0,'0')`,
  ).run();
  expect((await buildPools(env)).fresh).toEqual([
    'unseen-high',
    'unseen-low',
    'seen-high',
  ]);
});

it('assigns independent keys on insert and preserves them when ratings change or seeds retry', async () => {
  await env.APP.prepare(
    `INSERT INTO word_stats (card_id,prior,score,updated_at) VALUES
    ('-suffix',0.8,0.5,0),('word',0.8,0.5,0)`,
  ).run();
  const query = env.APP.prepare(
    'SELECT card_id,pool_order FROM word_stats ORDER BY card_id',
  );
  const before = await query.all<{ card_id: string; pool_order: string }>();
  expect(
    before.results.every(({ pool_order }) => /^[0-9A-F]{16}$/.test(pool_order)),
  ).toBe(true);
  expect(new Set(before.results.map(({ pool_order }) => pool_order)).size).toBe(
    2,
  );
  await env.APP.prepare(
    'UPDATE word_stats SET likes=1,score=0.667,updated_at=1',
  ).run();
  await env.APP.prepare(
    "INSERT INTO word_stats (card_id,prior,score,updated_at) VALUES ('-suffix',0.8,0.5,0) ON CONFLICT(card_id) DO NOTHING",
  ).run();
  expect((await query.all()).results).toEqual(before.results);
});
