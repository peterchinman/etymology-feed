import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { describe, expect, it } from 'vitest';
import { getUserFeed, getWildFeed } from '../src/feed';
import { buildPools, poolsKey } from '../src/pools';
import { deleteLiked, syncSwipes } from '../src/sync';

// These scoring/rollback regressions exercise the full dictionary. Preference
// filtering and its additional scan budget are covered in proper-nouns.test.ts.
const getUnfilteredFeed = (
  bindings: CloudflareBindings,
  userId: string,
  count: number,
  known: string[] = [],
) => getUserFeed(bindings, userId, count, known, true);

describe('dictionary and persistent feed API', () => {
  it('loads the 501-card fixture and responds to health checks', async () => {
    const response = await SELF.fetch('http://localhost/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      dictCards: 501,
      appCommit: 'local',
      dictRelease: 'local-fixture',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves 100 distinct wild cards within the D1 read budget', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/feed?n=100&includeProperNouns=true',
    );
    expect(response.status).toBe(200);
    const { cards } = (await response.json()) as { cards: Card[] };
    expect(cards).toHaveLength(100);
    expect(new Set(cards.map((card) => card.id)).size).toBe(100);
    // Nothing is rated yet, so the confirmed and promising slots fill through
    // to the fresh lane and the recorded bucket says so.
    expect(cards.filter((card) => card.bucket === 'fresh')).toHaveLength(90);
    expect(cards.filter((card) => card.bucket === 'wild')).toHaveLength(10);

    const direct = await getWildFeed({ dict: env.DICT }, 100, undefined, true);
    expect(direct.rowsRead).toBeLessThanOrEqual(101);

    const wrapped = await getWildFeed({ dict: env.DICT }, 100, 450, true);
    expect(wrapped.cards).toHaveLength(100);
    expect(new Set(wrapped.cards.map((card) => card.id)).size).toBe(100);
    expect(wrapped.rowsRead).toBeLessThanOrEqual(101);
  });

  it('looks up cards by ID and legacy primary headwords', async () => {
    const { cards } = await getWildFeed({ dict: env.DICT }, 1);
    const response = await SELF.fetch(
      `http://localhost/api/cards/${encodeURIComponent(cards[0].id)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const card = (await response.json()) as Card;
    expect(card.id).toBe(cards[0].id);
    expect(card.definition.length).toBeGreaterThan(0);

    const primary = await SELF.fetch('http://localhost/api/words/bluff');
    expect(primary.status).toBe(200);
    expect(((await primary.json()) as Card).id).toBe('bluff');

    const multiword = await SELF.fetch(
      `http://localhost/api/words/${encodeURIComponent('béarnaise sauce')}`,
    );
    expect(multiword.status).toBe(200);
    expect(((await multiword.json()) as Card).word).toBe('béarnaise sauce');
  });

  it('keeps separate bluff origins, definitions, and ratings', async () => {
    const response = await SELF.fetch(
      'http://localhost/api/words/bluff/etymologies',
    );
    expect(response.status).toBe(200);
    const { cards } = (await response.json()) as { cards: Card[] };
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const direct = await SELF.fetch(
        `http://localhost/api/cards/${encodeURIComponent(card.id)}`,
      );
      expect(direct.status).toBe(200);
      expect(await direct.json()).toEqual(card);
    }
    expect(cards.map(({ etymNo }) => etymNo)).toEqual([1, 2]);
    expect(cards[0].definition).toContain('bluffing');
    expect(cards[1].definition).toContain('steep bank');
    expect(cards[1].etymology).toContain('Middle Low German');

    const excluded = await env.DICT.prepare('SELECT id FROM word WHERE word<>?')
      .bind('bluff')
      .all<{ id: string }>();
    const feedUser = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(feedUser, 'Test', `${feedUser}@test.local`, Date.now())
      .run();
    const feed = await getUnfilteredFeed(
      env,
      feedUser,
      2,
      excluded.results.map(({ id }) => id),
    );
    expect(new Set(feed.cards.map(({ id }) => id))).toEqual(
      new Set(cards.map(({ id }) => id)),
    );

    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    const results = await syncSwipes(
      env,
      user,
      cards.map((card, index) => ({
        id: crypto.randomUUID(),
        cardId: card.id,
        verdict: (index ? 1 : -1) as 1 | -1,
        shownAt: Date.now(),
        swipedAt: Date.now() + index,
      })),
    );
    expect(results.results.map(({ status }) => status)).toEqual([
      'synced',
      'synced',
    ]);
    const stats = await env.APP.prepare(
      'SELECT card_id,likes,dislikes FROM word_stats WHERE card_id IN (?,?) ORDER BY card_id',
    )
      .bind(cards[0].id, cards[1].id)
      .all<{ card_id: string; likes: number; dislikes: number }>();
    expect(stats.results).toEqual([
      { card_id: cards[0].id, likes: 0, dislikes: 1 },
      { card_id: cards[1].id, likes: 1, dislikes: 0 },
    ]);
    expect(await deleteLiked(env, user, cards[1].id)).toBe(true);
    expect(await deleteLiked(env, user, cards[0].id)).toBe(false);
  });

  it('rejects a batch above the 100-card limit', async () => {
    const response = await SELF.fetch('http://localhost/api/feed?n=101');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_query',
        message:
          'n must be an integer from 1 to 100; includeProperNouns must be true or false.',
      },
    });
  });

  it('builds every lane from its own index inside the cron read budget', async () => {
    const pools = await buildPools(env);
    // Each lane query reads only its own rows: the fixture has 501 unrated
    // cards and no ratings, so the whole refresh reads at most that plus the
    // populated rated lanes and the one meta row.
    expect(pools.fresh.length).toBeGreaterThan(0);
    expect(pools.rowsRead).toBeLessThanOrEqual(
      Number(env.FRESH_POOL_SIZE) +
        pools.confirmed.length +
        pools.promising.length,
    );
    const plans = await env.APP.batch([
      env.APP.prepare(
        'EXPLAIN QUERY PLAN SELECT card_id,likes,dislikes FROM word_stats WHERE likes + dislikes >= 5 AND likes + dislikes >= ? AND score >= 0.5 AND score >= ? ORDER BY score DESC LIMIT ?',
      ).bind(5, 0.55, 3000),
      env.APP.prepare(
        'EXPLAIN QUERY PLAN SELECT card_id,likes,dislikes FROM word_stats WHERE likes > 0 AND (likes + dislikes < 5 OR score < 0.55) AND (likes + dislikes < 15 OR score >= 0.5) ORDER BY score DESC LIMIT ?',
      ).bind(3000),
      env.APP.prepare(
        'EXPLAIN QUERY PLAN SELECT card_id FROM word_stats WHERE likes = 0 AND likes + dislikes < ? ORDER BY likes + dislikes ASC, prior DESC LIMIT ?',
      ).bind(5, 3000),
    ]);
    const details = plans.map((plan) =>
      (plan.results as { detail: string }[]).map(({ detail }) => detail),
    );
    expect(details[0].some((d) => d.includes('idx_word_stats_rec'))).toBe(true);
    expect(details[1].some((d) => d.includes('idx_word_stats_promising'))).toBe(
      true,
    );
    expect(details[2].some((d) => d.includes('idx_word_stats_unrated'))).toBe(
      true,
    );
    expect(details.flat().some((d) => d.includes('TEMP B-TREE'))).toBe(false);
  });

  it('promotes on one like, survives lefts, and confirms only clearly above average', async () => {
    const newUser = async () => {
      const user = crypto.randomUUID();
      await env.APP.prepare(
        'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
      )
        .bind(user, 'Test', `${user}@test.local`, Date.now())
        .run();
      return user;
    };
    const rater = await newUser();
    // Other scenarios share APP: choose unrated cards for this scoring exercise.
    const unrated = await env.APP.prepare(
      'SELECT card_id AS id FROM word_stats WHERE likes = 0 AND dislikes = 0 ORDER BY card_id LIMIT 3',
    ).all<{ id: string }>();
    const [liked, disliked, average] = unrated.results;
    const swipe = (cardId: string, verdict: 1 | -1) => ({
      id: crypto.randomUUID(),
      cardId,
      verdict,
      shownAt: Date.now(),
      swipedAt: Date.now(),
    });
    const scoreOf = async (cardId: string) =>
      (
        await env.APP.prepare('SELECT score FROM word_stats WHERE card_id = ?')
          .bind(cardId)
          .first<{ score: number }>()
      )?.score;
    const laneOf = (
      pools: Awaited<ReturnType<typeof buildPools>>,
      id: string,
    ) =>
      pools.confirmed.some(([c]) => c === id)
        ? 'confirmed'
        : pools.promising.some(([c]) => c === id)
          ? 'promising'
          : pools.fresh.includes(id)
            ? 'fresh'
            : 'parked';
    await syncSwipes(env, rater, [
      swipe(liked.id, 1),
      swipe(disliked.id, -1),
      swipe(average.id, 1),
    ]);
    // Weighted lefts at 0.25: one like is 2/3, one left is 1/2.25.
    expect(await scoreOf(liked.id)).toBeCloseTo(2 / 3);
    expect(await scoreOf(disliked.id)).toBeCloseTo(1 / 2.25);

    let pools = await buildPools(env);
    expect(pools.promising).toContainEqual([liked.id, 1, 0]);
    // One left does not seal a card's fate: it waits at the tail of the fresh
    // lane behind every never-seen card (an earlier test left one other
    // once-passed card there).
    expect(laneOf(pools, disliked.id)).toBe('fresh');
    expect(pools.fresh.indexOf(disliked.id)).toBeGreaterThanOrEqual(
      pools.fresh.length - 2,
    );
    expect(laneOf(pools, average.id)).toBe('promising');
    expect(pools.confirmed).toHaveLength(0);

    // Another user sees the liked card in a promising slot on their next fetch.
    const reader = await newUser();
    const { cards } = await getUnfilteredFeed(env, reader, 20);
    // Wild draws happen first and may legitimately pick a rated card.
    expect(['promising', 'wild']).toContain(
      cards.find((card) => card.id === liked.id)?.bucket,
    );

    // Two strangers swiping past do not veto the like: still promising.
    for (let i = 0; i < 2; i++)
      await syncSwipes(env, await newUser(), [swipe(liked.id, -1)]);
    pools = await buildPools(env);
    expect(pools.promising).toContainEqual([liked.id, 1, 2]);
    expect(await scoreOf(liked.id)).toBeCloseTo(2 / 3.5);

    // Two more likes complete five looks at 3 likes / 2 lefts: clearly above
    // average, so confirmed. One like in five looks is exactly average, which
    // is not enough evidence to park: it stays promising.
    for (let i = 0; i < 2; i++)
      await syncSwipes(env, await newUser(), [swipe(liked.id, 1)]);
    for (let i = 0; i < 4; i++)
      await syncSwipes(env, await newUser(), [swipe(average.id, -1)]);
    pools = await buildPools(env);
    expect(pools.confirmed).toContainEqual([liked.id, 3, 2]);
    expect(await scoreOf(liked.id)).toBeCloseTo(4 / 5.5);
    expect(await scoreOf(average.id)).toBeCloseTo(0.5);
    expect(pools.promising).toContainEqual([average.id, 1, 4]);
    const third = await newUser();
    const confirmedFeed = await getUnfilteredFeed(env, third, 20);
    expect(['confirmed', 'wild']).toContain(
      confirmedFeed.cards.find((card) => card.id === liked.id)?.bucket,
    );

    // Parking is the irreversible call, so it waits for fifteen looks below
    // average: ten more lefts take the card to 1 like / 14 lefts.
    for (let i = 0; i < 10; i++)
      await syncSwipes(env, await newUser(), [swipe(average.id, -1)]);
    pools = await buildPools(env);
    expect(await scoreOf(average.id)).toBeCloseTo(2 / 6.5);
    expect(laneOf(pools, average.id)).toBe('parked');
    const fourth = await newUser();
    const laterFeed = await getUnfilteredFeed(env, fourth, 20);
    const parked = laterFeed.cards.find((card) => card.id === average.id);
    if (parked) expect(parked.bucket).toBe('wild');
  });

  it('keeps a 100-card fetch inside the read and write budgets', async () => {
    await buildPools(env);
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    const result = await getUnfilteredFeed(env, user, 100);
    expect(result.cards).toHaveLength(100);
    // Dictionary + current like totals: one indexed read per card in each DB.
    expect(result.rowsRead).toBeLessThanOrEqual(201);
    expect(result.rowsWritten).toBe(1);
    const repeated = await getUnfilteredFeed(env, user, 100);
    expect(repeated.cards).toHaveLength(100);
    expect(
      new Set([...result.cards, ...repeated.cards].map(({ id }) => id)).size,
    ).toBe(200);
  });

  it('syncs 100 swipes and keeps repeats idempotent', async () => {
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    const cards = (await getUnfilteredFeed(env, user, 100)).cards;
    const swipes = cards.map((card, i) => ({
      id: crypto.randomUUID(),
      cardId: card.id,
      verdict: (i % 2 ? 1 : -1) as 1 | -1,
      bucket: card.bucket,
      shownAt: Date.now(),
      swipedAt: Date.now() + i,
    }));
    const firstLiked = swipes[1];
    const baseline = await env.APP.prepare(
      'SELECT likes,dislikes FROM word_stats WHERE card_id=?',
    )
      .bind(firstLiked.cardId)
      .first<{ likes: number; dislikes: number }>();
    if (!baseline) throw new Error('Fixture statistics are missing.');
    const first = await syncSwipes(env, user, swipes);
    expect(first.results.every(({ status }) => status === 'synced')).toBe(true);
    const again = await syncSwipes(env, user, swipes);
    expect(again.results.every(({ status }) => status === 'duplicate')).toBe(
      true,
    );
    expect(again.rowsWritten).toBe(0);
    const replacement = {
      ...firstLiked,
      id: crypto.randomUUID(),
      verdict: -1 as const,
      swipedAt: firstLiked.swipedAt + 1000,
    };
    const changed = await syncSwipes(env, user, [replacement]);
    expect(changed.results[0].status).toBe('synced');
    const stat = await env.APP.prepare(
      'SELECT likes,dislikes FROM word_stats WHERE card_id=?',
    )
      .bind(firstLiked.cardId)
      .first<{ likes: number; dislikes: number }>();
    expect(stat).toMatchObject({
      likes: baseline.likes,
      dislikes: baseline.dislikes + 1,
    });
    const stale = await syncSwipes(env, user, [firstLiked]);
    expect(stale.results[0].status).toBe('duplicate');
    expect(stale.rowsWritten).toBe(0);
    const unlike = swipes[3];
    expect(await deleteLiked(env, user, unlike.cardId)).toBe(true);
    expect(await deleteLiked(env, user, unlike.cardId)).toBe(false);
    const mixed = await syncSwipes(env, user, [
      { id: 'bad-id', cardId: unlike.cardId },
      swipes[0],
    ]);
    expect(mixed.results.map(({ status }) => status)).toEqual([
      'invalid',
      'duplicate',
    ]);
    expect(first.rowsWritten).toBeLessThanOrEqual(650);
  });

  it('fills rollback batches from active DICT and preserves ratings on retry', async () => {
    const id = 'release-retry-card';
    const insertCard = () =>
      env.DICT.prepare(
        `INSERT INTO word SELECT ?, ?, etym_no, ipa, tier, zipf, shape, pos,
       definition, def_pos, etymology, etym_len, etym_band, has_signal, prior, 502
       FROM word WHERE id = 'bluff'`,
      )
        .bind(id, id)
        .run();
    const reader = async () => {
      const user = crypto.randomUUID();
      await env.APP.prepare(
        'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
      )
        .bind(user, 'Test', `${user}@test.local`, Date.now())
        .run();
      return user;
    };
    const seed = () =>
      env.APP.prepare(
        'INSERT INTO word_stats VALUES (?,0,0,0.6,0.5,0) ON CONFLICT(card_id) DO NOTHING',
      )
        .bind(id)
        .run();
    // A new card can receive a like before a post-deploy check fails.
    await insertCard();
    await env.DICT.prepare(
      "UPDATE meta SET value='502' WHERE key='row_count'",
    ).run();
    await seed();
    const rater = await reader();
    const swipe = {
      id: crypto.randomUUID(),
      cardId: id,
      verdict: 1,
      shownAt: Date.now(),
      swipedAt: Date.now(),
    };
    expect((await syncSwipes(env, rater, [swipe])).results[0].status).toBe(
      'synced',
    );
    const rating = await env.APP.prepare(
      'SELECT * FROM word_stats WHERE card_id=?',
    )
      .bind(id)
      .first();
    // Restore the old DICT, leaving APP statistics and swipes intact.
    await env.DICT.prepare('DELETE FROM word WHERE id=?').bind(id).run();
    await env.DICT.prepare(
      "UPDATE meta SET value='501' WHERE key='row_count'",
    ).run();
    const pools = await buildPools(env);
    const missing = Array.from({ length: 1000 }, (_, i) => `absent-${i}`);
    // Model a pool dominated by newly seeded IDs, including a rated new card.
    await env.CACHE.put(
      poolsKey(env),
      JSON.stringify({
        ...pools,
        confirmed: [],
        promising: [[id, 1, 0]],
        fresh: missing,
      }),
    );
    const user = await reader();
    // Known IDs from another release must not falsely imply DICT exhaustion.
    const known = Array.from({ length: 600 }, (_, i) => `other-release-${i}`);
    const first = await getUnfilteredFeed(env, user, 100, known);
    const second = await getUnfilteredFeed(env, user, 100);
    expect(first.cards).toHaveLength(100);
    expect(second.cards).toHaveLength(100);
    const delivered = [...first.cards, ...second.cards].map((card) => card.id);
    expect(new Set(delivered).size).toBe(200);
    expect(delivered).not.toContain(id);
    expect(delivered.some((card) => missing.includes(card))).toBe(false);
    expect(first.rowsRead).toBeLessThanOrEqual(1201);
    expect(first.rowsWritten).toBe(1);
    const served = await env.APP.prepare(
      'SELECT card_ids FROM served WHERE user_id=?',
    )
      .bind(user)
      .first<{ card_ids: string }>();
    expect(JSON.parse(served?.card_ids ?? '[]')).toEqual([
      ...known,
      ...delivered,
    ]);
    // Retrying the new release makes the card available without resetting its like.
    await insertCard();
    await env.DICT.prepare(
      "UPDATE meta SET value='502' WHERE key='row_count'",
    ).run();
    await seed();
    await buildPools(env);
    const alreadyKnown = await env.DICT.prepare(
      'SELECT id FROM word WHERE id != ? ORDER BY shuffle LIMIT 402',
    )
      .bind(id)
      .all<{ id: string }>();
    const retried = await getUnfilteredFeed(
      env,
      await reader(),
      100,
      alreadyKnown.results.map((row) => row.id),
    );
    expect(retried.cards).toHaveLength(100);
    expect(retried.cards.map((card) => card.id)).toContain(id);
    expect(
      await env.APP.prepare('SELECT * FROM word_stats WHERE card_id=?')
        .bind(id)
        .first(),
    ).toEqual(rating);
    expect(
      await env.APP.prepare('SELECT verdict FROM swipe WHERE id=?')
        .bind(swipe.id)
        .first(),
    ).toEqual({ verdict: 1 });
  });
});
