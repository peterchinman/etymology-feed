import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { expect, it } from 'vitest';
import { getCardsByIds, getWildFeed } from '../src/feed';
import { poolsKey } from '../src/pools';

it('filters every feed lane by default, permits opt-in, and retains lookup history', async () => {
  const names = await env.DICT.prepare(
    'SELECT id,def_pos FROM word WHERE shuffle<=250 ORDER BY shuffle',
  ).all<{ id: string; def_pos: string }>();
  try {
    await env.DICT.prepare(
      "UPDATE word SET def_pos='proper noun' WHERE shuffle<=250",
    ).run();
    const ids = names.results.map(({ id }) => id);
    await env.CACHE.put(
      poolsKey(env),
      JSON.stringify({
        builtAt: Date.now(),
        cardCount: 501,
        confirmed: ids.map((id) => [id, 10, 0]),
        promising: ids.map((id) => [id, 1, 0]),
        fresh: ids,
      }),
    );
    for (const suffix of ['', '&includeProperNouns=false']) {
      const response = await SELF.fetch(
        `http://localhost/api/feed?n=100${suffix}`,
      );
      expect(response.status).toBe(200);
      const { cards } = (await response.json()) as { cards: Card[] };
      expect(cards).toHaveLength(100);
      expect(new Set(cards.map(({ id }) => id)).size).toBe(100);
      expect(cards.every(({ defPos }) => defPos !== 'proper noun')).toBe(true);
    }
    const included = await SELF.fetch(
      'http://localhost/api/feed?n=100&includeProperNouns=true',
    );
    expect(included.status).toBe(200);
    expect(
      ((await included.json()) as { cards: Card[] }).cards.some(
        ({ defPos }) => defPos === 'proper noun',
      ),
    ).toBe(true);
    const wild = await getWildFeed({ dict: env.DICT }, 100, 1);
    expect(wild.cards.every(({ defPos }) => defPos !== 'proper noun')).toBe(
      true,
    );
    expect(wild.rowsRead).toBeLessThanOrEqual(1001);
    const optedIn = await getWildFeed({ dict: env.DICT }, 10, 1, true);
    expect(optedIn.cards.every(({ defPos }) => defPos === 'proper noun')).toBe(
      true,
    );
    expect((await getCardsByIds(env.DICT, [ids[0]])).get(ids[0])?.defPos).toBe(
      'proper noun',
    );
    const invalid = await SELF.fetch(
      'http://localhost/api/feed?includeProperNouns=yes',
    );
    expect(invalid.status).toBe(400);
  } finally {
    await env.DICT.batch(
      names.results.map((row) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          row.def_pos,
          row.id,
        ),
      ),
    );
    await env.CACHE.delete(poolsKey(env));
  }
});
