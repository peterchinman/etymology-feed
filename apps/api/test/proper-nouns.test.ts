import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { expect, it } from 'vitest';
import { getCardsByIds, getUserFeed, getWildFeed } from '../src/feed';
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

it.each(['filtered', 'missing'])(
  'fills %s and exhausted slots without moving surviving pool cards to the front',
  async (reason) => {
    const rows = await env.DICT.prepare(
      'SELECT id,def_pos FROM word ORDER BY shuffle LIMIT 3',
    ).all<{ id: string; def_pos: string }>();
    const [first, name, third] = rows.results;
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    try {
      await env.DICT.batch([
        env.DICT.prepare(
          "UPDATE word SET def_pos='suffix' WHERE id IN (?,?)",
        ).bind(first.id, third.id),
        env.DICT.prepare(
          "UPDATE word SET def_pos='proper noun' WHERE id=?",
        ).bind(name.id),
      ]);
      await env.CACHE.put(
        poolsKey(env),
        JSON.stringify({
          builtAt: Date.now(),
          cardCount: 501,
          confirmed: [[first.id, 10, 0]],
          promising: [[reason === 'filtered' ? name.id : 'absent-card', 1, 0]],
          fresh: [third.id],
        }),
      );
      const result = await getUserFeed(
        {
          ...env,
          CONFIRMED_SLOTS: 1,
          PROMISING_SLOTS: 1,
          FRESH_SLOTS: 1,
          WILD_SLOTS: 0,
        },
        user,
        6,
      );
      expect(result.cards).toHaveLength(6);
      expect(new Set(result.cards.map(({ id }) => id)).size).toBe(6);
      expect(result.cards[0].id).toBe(first.id);
      expect(result.cards[2].id).toBe(third.id);
      expect(result.cards.map(({ bucket }) => bucket)).toEqual([
        'confirmed',
        'wild',
        'fresh',
        'wild',
        'wild',
        'wild',
      ]);
      expect(result.cards.every(({ defPos }) => defPos !== 'proper noun')).toBe(
        true,
      );
      expect(result.rowsWritten).toBe(1);
      expect(result.rowsRead).toBeLessThanOrEqual(1010);
      const served = await env.APP.prepare(
        'SELECT card_ids FROM served WHERE user_id=?',
      )
        .bind(user)
        .first<{ card_ids: string }>();
      expect(JSON.parse(served?.card_ids ?? '[]')).toEqual(
        result.cards.map(({ id }) => id),
      );
    } finally {
      await env.DICT.batch(
        rows.results.map(({ id, def_pos }) =>
          env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
            def_pos,
            id,
          ),
        ),
      );
      await env.CACHE.delete(poolsKey(env));
    }
  },
);
