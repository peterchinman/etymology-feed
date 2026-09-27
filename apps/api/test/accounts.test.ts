import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  deleteAccount,
  getAccountLikes,
  mergeAnonymousAccount,
} from '../src/accounts';
import { getWordEtymologies } from '../src/feed';
import { syncSwipes } from '../src/sync';

it('merges newer anonymous verdicts, deduplicates served cards, and removes account ratings', async () => {
  const [bluffing, bank] = await getWordEtymologies(
    { dict: env.DICT },
    'bluff',
  );
  const third = await env.DICT.prepare(
    'SELECT id FROM word WHERE word<>? ORDER BY shuffle LIMIT 1',
  )
    .bind('bluff')
    .first<{ id: string }>();
  if (!third) throw new Error('Fixture is missing a third card.');
  const thirdId = third.id;
  const guest = crypto.randomUUID();
  const member = crypto.randomUUID();
  for (const [id, isAnonymous] of [
    [guest, 1],
    [member, 0],
  ] as const)
    await env.APP.prepare(
      'INSERT INTO user(id,name,email,updated_at,is_anonymous) VALUES(?,?,?,?,?)',
    )
      .bind(id, 'Test', `${id}@test.local`, Date.now(), isAnonymous)
      .run();
  const swipe = (cardId: string, verdict: 1 | -1, swipedAt: number) => ({
    id: crypto.randomUUID(),
    cardId,
    verdict,
    shownAt: swipedAt - 1,
    swipedAt,
  });
  const memberSwipes = [swipe(bluffing.id, -1, 1000), swipe(bank.id, 1, 2000)];
  const guestSwipes = [
    swipe(bluffing.id, 1, 2000),
    swipe(bank.id, -1, 1000),
    swipe(thirdId, 1, 3000),
  ];
  await syncSwipes(env, member, memberSwipes);
  await syncSwipes(env, guest, guestSwipes);

  await mergeAnonymousAccount(env, guest, member);
  await mergeAnonymousAccount(env, guest, member); // safe if the hook retries
  const merged = await env.APP.prepare(
    'SELECT card_id,verdict FROM swipe WHERE user_id=? ORDER BY card_id',
  )
    .bind(member)
    .all<{ card_id: string; verdict: number }>();
  expect(
    new Map(merged.results.map((row) => [row.card_id, row.verdict])),
  ).toEqual(
    new Map([
      [bluffing.id, 1],
      [bank.id, 1],
      [thirdId, 1],
    ]),
  );
  const stats = await env.APP.prepare(
    'SELECT card_id,likes,dislikes,score FROM word_stats WHERE card_id IN (?,?,?)',
  )
    .bind(bluffing.id, bank.id, thirdId)
    .all<{ card_id: string; likes: number; dislikes: number; score: number }>();
  expect(
    stats.results.every((row) => row.likes === 1 && row.dislikes === 0),
  ).toBe(true);
  for (const row of stats.results) expect(row.score).toBeCloseTo(2 / 3);
  const served = await env.APP.prepare(
    'SELECT card_ids FROM served WHERE user_id=?',
  )
    .bind(member)
    .first<{ card_ids: string }>();
  if (!served) throw new Error('Merged served history is missing.');
  expect(JSON.parse(served.card_ids)).toEqual([bluffing.id, bank.id, thirdId]);

  const firstPage = await getAccountLikes(env, member, 1);
  expect(firstPage.likes).toHaveLength(1);
  expect(firstPage.likes[0].card.id).toBe(thirdId);
  if (!firstPage.nextCursor) throw new Error('First page lacks a cursor.');
  const [swipedAt, id] = JSON.parse(atob(firstPage.nextCursor)) as [
    number,
    string,
  ];
  const secondPage = await getAccountLikes(env, member, 2, { swipedAt, id });
  expect(secondPage.likes.map(({ cardId }) => cardId).sort()).toEqual(
    [bluffing.id, bank.id].sort(),
  );
  expect(secondPage.nextCursor).toBeNull();
  const likesPlan = await env.APP.prepare(`
    EXPLAIN QUERY PLAN SELECT id,card_id,bucket,shown_at,swiped_at FROM swipe
    WHERE user_id=? AND verdict=1
      AND (? IS NULL OR swiped_at<? OR (swiped_at=? AND id<?))
    ORDER BY swiped_at DESC,id DESC LIMIT ?
  `)
    .bind(member, null, null, null, null, 201)
    .all<{ detail: string }>();
  expect(
    likesPlan.results.some(({ detail }) =>
      detail.includes('idx_swipe_user_liked'),
    ),
  ).toBe(true);
  expect(
    likesPlan.results.some(({ detail }) => detail.includes('TEMP B-TREE')),
  ).toBe(false);

  await env.APP.prepare('DELETE FROM user WHERE id=?').bind(guest).run();
  await deleteAccount(env, member);
  const after = await env.APP.prepare(
    'SELECT likes,dislikes,score FROM word_stats WHERE card_id IN (?,?,?)',
  )
    .bind(bluffing.id, bank.id, thirdId)
    .all<{ likes: number; dislikes: number; score: number }>();
  expect(
    after.results.every(
      (row) => row.likes === 0 && row.dislikes === 0 && row.score === 0.5,
    ),
  ).toBe(true);
  expect(
    await env.APP.prepare('SELECT id FROM user WHERE id=?')
      .bind(member)
      .first(),
  ).toBeNull();
});

it('counts matching ratings once under weighted scoring after account linking', async () => {
  const cards = await env.DICT.prepare(
    'SELECT id FROM word ORDER BY shuffle LIMIT 2 OFFSET 4',
  ).all<{ id: string }>();
  if (cards.results.length !== 2) throw new Error('Fixture cards are missing.');
  for (const [index, verdict] of ([1, -1] as const).entries()) {
    const card = cards.results[index];
    const guest = crypto.randomUUID();
    const member = crypto.randomUUID();
    for (const [id, anonymous] of [
      [guest, 1],
      [member, 0],
    ] as const)
      await env.APP.prepare(
        'INSERT INTO user(id,name,email,updated_at,is_anonymous) VALUES(?,?,?,?,?)',
      )
        .bind(id, 'Test', `${id}@test.local`, Date.now(), anonymous)
        .run();
    for (const [id, swipedAt] of [
      [guest, 2000],
      [member, 1000],
    ] as const)
      await syncSwipes(env, id, [
        {
          id: crypto.randomUUID(),
          cardId: card.id,
          verdict,
          shownAt: swipedAt - 1,
          swipedAt,
        },
      ]);
    await mergeAnonymousAccount(env, guest, member);
    const stats = await env.APP.prepare(
      'SELECT likes,dislikes,score FROM word_stats WHERE card_id=?',
    )
      .bind(card.id)
      .first<{ likes: number; dislikes: number; score: number }>();
    expect(stats?.likes).toBe(verdict === 1 ? 1 : 0);
    expect(stats?.dislikes).toBe(verdict === -1 ? 1 : 0);
    expect(stats?.score).toBeCloseTo(verdict === 1 ? 2 / 3 : 1 / 2.25);
    expect(
      await env.APP.prepare('SELECT count(*) AS n FROM swipe WHERE card_id=?')
        .bind(card.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    await deleteAccount(env, member);
    expect(
      await env.APP.prepare('SELECT score FROM word_stats WHERE card_id=?')
        .bind(card.id)
        .first<{ score: number }>(),
    ).toEqual({ score: 0.5 });
  }
});
