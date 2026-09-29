import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { expect, it } from 'vitest';
import { getUserFeed } from '../src/feed';
import { withLikeCounts } from '../src/likes';
import { buildPools } from '../src/pools';
import { deleteLiked, syncSwipes } from '../src/sync';

async function newUser() {
  const id = crypto.randomUUID();
  await env.APP.prepare(
    'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
  )
    .bind(id, 'Test', `${id}@test.local`, Date.now())
    .run();
  return id;
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

  // Read fresh APP totals even when selection uses an older cached pool.
  const excluded = await env.DICT.prepare('SELECT id FROM word WHERE word <> ?')
    .bind('bluff')
    .all<{ id: string }>();
  const feed = await getUserFeed(
    env,
    await newUser(),
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

it('handles empty batches and cards without statistics', async () => {
  expect(await withLikeCounts(env.APP, [])).toEqual({ cards: [], rowsRead: 0 });
  const [card] = await origins();
  const counted = await withLikeCounts(env.APP, [
    { ...card, id: 'missing-stats' },
  ]);
  expect(counted.cards[0].likeCount).toBe(0);
  expect(counted.rowsRead).toBe(0);
});
