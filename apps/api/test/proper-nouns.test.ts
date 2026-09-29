import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { expect, it, vi } from 'vitest';
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

it('replaces filtered fresh candidates from the same lane without a random scan', async () => {
  const original = await env.DICT.prepare(
    'SELECT id,def_pos FROM word ORDER BY shuffle LIMIT 200',
  ).all<{ id: string; def_pos: string }>();
  const ids = original.results.map(({ id }) => id);
  const userId = crypto.randomUUID();
  await env.APP.prepare(
    'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
  )
    .bind(userId, 'Test', `${userId}@test.local`, Date.now())
    .run();
  try {
    await env.DICT.batch(
      ids.map((id, index) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          index < 100 ? 'proper noun' : 'noun',
          id,
        ),
      ),
    );
    await env.CACHE.put(
      poolsKey(env),
      JSON.stringify({
        builtAt: Date.now(),
        cardCount: 501,
        confirmed: [],
        promising: [],
        fresh: ids,
      }),
    );
    // Keep the fresh lane ordered: its first 100 cards are all ineligible.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    // Wrangler generates literal slot types; this fixture isolates the fresh lane.
    const result = await getUserFeed(
      {
        ...env,
        CONFIRMED_SLOTS: 0,
        PROMISING_SLOTS: 0,
        FRESH_SLOTS: 20,
        WILD_SLOTS: 0,
      } as unknown as CloudflareBindings,
      userId,
      100,
    );
    random.mockRestore();
    expect(result.cards.map(({ id }) => id)).toEqual(ids.slice(100));
    expect(result.cards.every(({ bucket }) => bucket === 'fresh')).toBe(true);
    // One served lookup plus 200 candidate PK reads, with no range recovery.
    expect(result.rowsRead).toBeLessThanOrEqual(201);
    expect(result.rowsWritten).toBe(1);
    const served = await env.APP.prepare(
      'SELECT card_ids FROM served WHERE user_id=?',
    )
      .bind(userId)
      .first<{ card_ids: string }>();
    if (!served)
      throw new Error('Expected the completed batch to be recorded.');
    expect(JSON.parse(served.card_ids)).toEqual(ids.slice(100));
  } finally {
    vi.restoreAllMocks();
    await env.DICT.batch(
      original.results.map(({ id, def_pos }) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          def_pos,
          id,
        ),
      ),
    );
    await env.CACHE.delete(poolsKey(env));
  }
});

it('preserves the ranked lane mix and nonrepetition with mixed eligible pools', async () => {
  const original = await env.DICT.prepare(
    'SELECT id,def_pos FROM word ORDER BY shuffle LIMIT 360',
  ).all<{ id: string; def_pos: string }>();
  const ids = original.results.map(({ id }) => id);
  const userId = crypto.randomUUID();
  await env.APP.prepare(
    'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
  )
    .bind(userId, 'Test', `${userId}@test.local`, Date.now())
    .run();
  try {
    await env.DICT.batch(
      ids.map((id, index) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          index % 120 < 30 ? 'proper noun' : 'noun',
          id,
        ),
      ),
    );
    await env.CACHE.put(
      poolsKey(env),
      JSON.stringify({
        builtAt: Date.now(),
        cardCount: 501,
        confirmed: ids.slice(0, 120).map((id) => [id, 10, 0]),
        promising: ids.slice(120, 240).map((id) => [id, 1, 0]),
        fresh: ids.slice(240),
      }),
    );
    const seen = new Set<string>();
    for (let batch = 0; batch < 2; batch++) {
      const result = await getUserFeed(env, userId, 100);
      expect(result.cards).toHaveLength(100);
      for (const [bucket, total] of [
        ['confirmed', 30],
        ['promising', 30],
        ['fresh', 30],
        ['wild', 10],
      ] as const)
        expect(
          result.cards.filter((card) => card.bucket === bucket),
        ).toHaveLength(total);
      for (const card of result.cards) {
        expect(card.defPos).not.toBe('proper noun');
        expect(seen.has(card.id)).toBe(false);
        seen.add(card.id);
      }
    }
  } finally {
    await env.DICT.batch(
      original.results.map(({ id, def_pos }) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          def_pos,
          id,
        ),
      ),
    );
    await env.CACHE.delete(poolsKey(env));
  }
});

it('falls back at the ranked limit without marking filtered cards as served', async () => {
  const original = await env.DICT.prepare(
    "SELECT id,def_pos FROM word WHERE id != 'bluff' ORDER BY shuffle",
  ).all<{ id: string; def_pos: string }>();
  expect(original.results).toHaveLength(500);
  const userId = crypto.randomUUID();
  await env.APP.prepare(
    'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
  )
    .bind(userId, 'Test', `${userId}@test.local`, Date.now())
    .run();
  try {
    await env.DICT.prepare(
      "UPDATE word SET def_pos='proper noun' WHERE id != 'bluff'",
    ).run();
    await env.CACHE.put(
      poolsKey(env),
      JSON.stringify({
        builtAt: Date.now(),
        cardCount: 501,
        confirmed: [],
        promising: [],
        fresh: [...original.results.map(({ id }) => id), 'bluff'],
      }),
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const result = await getUserFeed(
      {
        ...env,
        CONFIRMED_SLOTS: 0,
        PROMISING_SLOTS: 0,
        FRESH_SLOTS: 20,
        WILD_SLOTS: 0,
      } as unknown as CloudflareBindings,
      userId,
      100,
    );
    // Only one eligible card exists. Recovery finds it and proves exhaustion.
    expect(result.cards.map(({ id, bucket }) => ({ id, bucket }))).toEqual([
      { id: 'bluff', bucket: 'wild' },
    ]);
    expect(result.rowsRead).toBeLessThanOrEqual(1002);
    const served = await env.APP.prepare(
      'SELECT card_ids FROM served WHERE user_id=?',
    )
      .bind(userId)
      .first<{ card_ids: string }>();
    expect(JSON.parse(served?.card_ids ?? '[]')).toEqual(['bluff']);
  } finally {
    vi.restoreAllMocks();
    await env.DICT.batch(
      original.results.map(({ id, def_pos }) =>
        env.DICT.prepare('UPDATE word SET def_pos=? WHERE id=?').bind(
          def_pos,
          id,
        ),
      ),
    );
    await env.CACHE.delete(poolsKey(env));
  }
});
