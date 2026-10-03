import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { expect, it } from 'vitest';
import { getAccountLikes } from '../src/accounts';
import { getUserFeed } from '../src/feed';
import { MAX_LIKE_COUNT_IDS, withLikeCounts } from '../src/likes';
import { buildPools } from '../src/pools';
import { deleteLiked, syncSwipes } from '../src/sync';
import { raterWith } from './helpers';

/** A trusted rater who was dealt both bluff origins. */
async function newUser() {
  return raterWith((await origins()).map(({ id }) => id));
}

async function origins() {
  const response = await SELF.fetch(
    'http://localhost/api/words/bluff/etymologies',
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { cards: Card[] }).cards;
}

it('exposes distinct user totals, updates after unlikes, and separates origins', async () => {
  const cards = await origins();
  expect(cards.map((card) => card.likeCount)).toEqual([0, 0]);
  await buildPools(env);
  const first = await newUser();
  const second = await newUser();
  const swipe = {
    id: crypto.randomUUID(),
    cardId: cards[0].id,
    verdict: 1,
    shownAt: Date.now(),
    swipedAt: Date.now(),
  };
  await syncSwipes(env, first, [swipe]);
  await syncSwipes(env, first, [swipe]);
  await syncSwipes(env, first, [
    { ...swipe, id: crypto.randomUUID(), swipedAt: swipe.swipedAt + 1 },
  ]);
  await syncSwipes(env, second, [{ ...swipe, id: crypto.randomUUID() }]);
  await syncSwipes(env, second, [
    { ...swipe, id: crypto.randomUUID(), cardId: cards[1].id, verdict: -1 },
  ]);
  expect((await origins()).map((card) => card.likeCount)).toEqual([2, 0]);

  // Liked refreshes totals by ID without a session; unknown IDs count 0.
  const counted = await SELF.fetch(
    `http://localhost/api/like-counts?${new URLSearchParams([
      ['id', cards[0].id],
      ['id', cards[1].id],
      ['id', 'missing-stats'],
    ])}`,
  );
  expect(counted.status).toBe(200);
  expect(counted.headers.get('Cache-Control')).toBe('no-store');
  expect(counted.headers.get('set-cookie')).toBeNull();
  expect(await counted.json()).toEqual({
    counts: { [cards[0].id]: 2, [cards[1].id]: 0, 'missing-stats': 0 },
  });
  const single = await SELF.fetch(
    `http://localhost/api/like-counts?id=${encodeURIComponent(cards[0].id)}`,
  );
  expect(await single.json()).toEqual({ counts: { [cards[0].id]: 2 } });
  // Signed-in Liked replaces local cards from the account, totals included.
  const { likes } = await getAccountLikes(env, first, 10);
  expect(likes.map(({ card }) => card.likeCount)).toEqual([2]);

  // Read fresh APP totals even when selection uses an older cached pool.
  const excluded = await env.DICT.prepare('SELECT id FROM word WHERE word <> ?')
    .bind('bluff')
    .all<{ id: string }>();
  const feed = await getUserFeed(
    env,
    await raterWith(),
    2,
    excluded.results.map(({ id }) => id),
  );
  expect(feed.cards.find((card) => card.id === cards[0].id)?.likeCount).toBe(2);
  expect(feed.cards.find((card) => card.id === cards[1].id)?.likeCount).toBe(0);

  for (const path of ['/api/cards/bluff', '/api/words/bluff']) {
    const response = await SELF.fetch(`http://localhost${path}`);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(((await response.json()) as Card).likeCount).toBe(2);
  }
  expect(await deleteLiked(env, first, cards[0].id)).toBe(true);
  expect(await deleteLiked(env, first, cards[0].id)).toBe(false);
  expect((await origins())[0].likeCount).toBe(1);
  await syncSwipes(env, second, [
    {
      ...swipe,
      id: crypto.randomUUID(),
      verdict: -1,
      swipedAt: swipe.swipedAt + 2,
    },
  ]);
  expect((await origins())[0].likeCount).toBe(0);
});

it('rejects like-count requests without IDs or with too many', async () => {
  const tooMany = Array.from({ length: MAX_LIKE_COUNT_IDS + 1 }, (_, index) => [
    'id',
    `card-${index}`,
  ]);
  for (const query of ['', 'id=', new URLSearchParams(tooMany).toString()]) {
    const response = await SELF.fetch(
      `http://localhost/api/like-counts?${query}`,
    );
    expect(response.status).toBe(400);
  }
});

it('handles empty batches and cards without statistics', async () => {
  expect(await withLikeCounts(env.APP, [])).toEqual({ cards: [], rowsRead: 0 });
  const [card] = await origins();
  const counted = await withLikeCounts(env.APP, [
    { ...card, id: 'missing-stats' },
  ]);
  expect(counted.cards[0].likeCount).toBe(0);
  expect(counted.rowsRead).toBe(0);
});

it.each([1, -1] as const)(
  'counts a concurrent retry of verdict %i only once',
  async (verdict) => {
    const user = await newUser();
    const [card] = await origins();
    const before = await env.APP.prepare(
      'SELECT likes,dislikes FROM word_stats WHERE card_id=?',
    )
      .bind(card.id)
      .first<{ likes: number; dislikes: number }>();
    if (!before) throw new Error('Fixture statistics are missing.');
    const beforeRows = await env.APP.prepare(
      'SELECT count(*) AS total FROM swipe WHERE card_id=?',
    )
      .bind(card.id)
      .first<{ total: number }>();
    const swipe = {
      id: crypto.randomUUID(),
      cardId: card.id,
      verdict,
      shownAt: Date.now(),
      swipedAt: Date.now(),
    };
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = {
      prepare: env.APP.prepare.bind(env.APP),
      batch: async (statements: D1PreparedStatement[]) => {
        const results = await env.APP.batch(statements);
        // Both requests must read the same absent swipe before either writes.
        if (reads < 2) {
          if (++reads === 2) release();
          await bothRead;
        }
        return results;
      },
    } as D1Database;
    const concurrentEnv = { ...env, APP: app };

    await Promise.all([
      syncSwipes(concurrentEnv, user, [swipe]),
      syncSwipes(concurrentEnv, user, [swipe]),
    ]);
    const stats = await env.APP.prepare(
      'SELECT likes,dislikes FROM word_stats WHERE card_id=?',
    )
      .bind(card.id)
      .first<{ likes: number; dislikes: number }>();
    expect(stats).toMatchObject({
      likes: before.likes + Number(verdict === 1),
      dislikes: before.dislikes + Number(verdict === -1),
    });
    expect(
      await env.APP.prepare(
        'SELECT count(*) AS total FROM swipe WHERE card_id=?',
      )
        .bind(card.id)
        .first<{ total: number }>(),
    ).toEqual({ total: (beforeRows?.total ?? 0) + 1 });
  },
);

it('decrements only once when the same like is removed concurrently', async () => {
  const user = await newUser();
  const [card] = await origins();
  const before = await env.APP.prepare(
    'SELECT likes FROM word_stats WHERE card_id=?',
  )
    .bind(card.id)
    .first<{ likes: number }>();
  if (!before) throw new Error('Fixture statistics are missing.');
  await syncSwipes(env, user, [
    {
      id: crypto.randomUUID(),
      cardId: card.id,
      verdict: 1,
      shownAt: Date.now(),
      swipedAt: Date.now(),
    },
  ]);
  expect(
    (
      await Promise.all([
        deleteLiked(env, user, card.id),
        deleteLiked(env, user, card.id),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect(
    await env.APP.prepare('SELECT likes FROM word_stats WHERE card_id=?')
      .bind(card.id)
      .first<{ likes: number }>(),
  ).toEqual({ likes: before.likes });
});
