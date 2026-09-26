import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { describe, expect, it } from 'vitest';
import { getUserFeed, getWildFeed } from '../src/feed';
import { buildPools } from '../src/pools';
import { buildNightlyStats } from '../src/stats';
import { deleteLiked, syncSwipes } from '../src/sync';

describe('dictionary and persistent feed API', () => {
  it('loads the 500-word fixture and responds to health checks', async () => {
    const response = await SELF.fetch('http://localhost/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', dictWords: 500 });
  });

  it('serves 100 distinct wild cards within the D1 read budget', async () => {
    const response = await SELF.fetch('http://localhost/api/feed?n=100');
    expect(response.status).toBe(200);
    const { cards } = (await response.json()) as { cards: Card[] };
    expect(cards).toHaveLength(100);
    expect(new Set(cards.map((card) => card.word)).size).toBe(100);
    expect(cards.some((card) => card.bucket === 'rec')).toBe(true);
    expect(cards.some((card) => card.bucket === 'unknown')).toBe(true);
    expect(cards.some((card) => card.bucket === 'wild')).toBe(true);

    const direct = await getWildFeed({ dict: env.DICT }, 100);
    expect(direct.rowsRead).toBeLessThanOrEqual(101);

    const wrapped = await getWildFeed({ dict: env.DICT }, 100, 450);
    expect(wrapped.cards).toHaveLength(100);
    expect(new Set(wrapped.cards.map((card) => card.word)).size).toBe(100);
    expect(wrapped.rowsRead).toBeLessThanOrEqual(101);
  });

  it('looks up a headword and caches the card', async () => {
    const { cards } = await getWildFeed({ dict: env.DICT }, 1);
    const response = await SELF.fetch(
      `http://localhost/api/words/${encodeURIComponent(cards[0].word)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const card = (await response.json()) as Card;
    expect(card.word).toBe(cards[0].word);
    expect(card.definition.length).toBeGreaterThan(0);

    const multiword = await SELF.fetch(
      `http://localhost/api/words/${encodeURIComponent('béarnaise sauce')}`,
    );
    expect(multiword.status).toBe(200);
    expect(((await multiword.json()) as Card).word).toBe('béarnaise sauce');
  });

  it('rejects a batch above the 100-card limit', async () => {
    const response = await SELF.fetch('http://localhost/api/feed?n=101');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_query',
        message: 'n must be an integer from 1 to 100.',
      },
    });
  });

  it('keeps a 100-card fetch inside the read and write budgets', async () => {
    await buildPools(env);
    const plan = await env.APP.prepare(
      'EXPLAIN QUERY PLAN SELECT word,likes,dislikes,prior FROM word_stats WHERE likes + dislikes >= 5 AND likes + dislikes >= ? AND score >= 0.5 ORDER BY score DESC LIMIT ?',
    )
      .bind(5, 3000)
      .all<{ detail: string }>();
    expect(
      plan.results.some(({ detail }) => detail.includes('idx_word_stats_rec')),
    ).toBe(true);
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    const result = await getUserFeed(env, user, 100);
    expect(result.cards).toHaveLength(100);
    expect(result.rowsRead).toBeLessThanOrEqual(101);
    expect(result.rowsWritten).toBe(1);
    const repeated = await getUserFeed(env, user, 100);
    expect(repeated.cards).toHaveLength(100);
    expect(
      new Set([...result.cards, ...repeated.cards].map(({ word }) => word))
        .size,
    ).toBe(200);
  });

  it('syncs 100 swipes and keeps repeats idempotent', async () => {
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    const cards = (await getUserFeed(env, user, 100)).cards;
    const swipes = cards.map((card, i) => ({
      id: crypto.randomUUID(),
      word: card.word,
      verdict: (i % 2 ? 1 : -1) as 1 | -1,
      bucket: card.bucket,
      shownAt: Date.now(),
      swipedAt: Date.now() + i,
    }));
    const first = await syncSwipes(env, user, swipes);
    expect(first.results.every(({ status }) => status === 'synced')).toBe(true);
    const again = await syncSwipes(env, user, swipes);
    expect(again.results.every(({ status }) => status === 'duplicate')).toBe(
      true,
    );
    expect(again.rowsWritten).toBe(0);
    const firstLiked = swipes[1];
    const replacement = {
      ...firstLiked,
      id: crypto.randomUUID(),
      verdict: -1 as const,
      swipedAt: firstLiked.swipedAt + 1000,
    };
    const changed = await syncSwipes(env, user, [replacement]);
    expect(changed.results[0].status).toBe('synced');
    const stat = await env.APP.prepare(
      'SELECT likes,dislikes FROM word_stats WHERE word=?',
    )
      .bind(firstLiked.word)
      .first<{ likes: number; dislikes: number }>();
    expect(stat).toMatchObject({ likes: 0, dislikes: 1 });
    const stale = await syncSwipes(env, user, [firstLiked]);
    expect(stale.results[0].status).toBe('duplicate');
    expect(stale.rowsWritten).toBe(0);
    const unlike = swipes[3];
    expect(await deleteLiked(env, user, unlike.word)).toBe(true);
    expect(await deleteLiked(env, user, unlike.word)).toBe(false);
    const mixed = await syncSwipes(env, user, [
      { id: 'bad-id', word: unlike.word },
      swipes[0],
    ]);
    expect(mixed.results.map(({ status }) => status)).toEqual([
      'invalid',
      'duplicate',
    ]);
    expect(first.rowsWritten).toBeLessThanOrEqual(550);
  });

  it('reports bucket, band, shape and global like-rates from the nightly snapshot', async () => {
    const yesterday = Date.now() - 86_400_000;
    const cards = [
      ...(await getWildFeed({ dict: env.DICT }, 100)).cards,
      ...(await getWildFeed({ dict: env.DICT }, 5, 100)).cards,
    ];
    const user = crypto.randomUUID();
    await env.APP.prepare(
      'INSERT INTO user (id,name,email,updated_at,is_anonymous) VALUES (?,?,?,?,1)',
    )
      .bind(user, 'Test', `${user}@test.local`, Date.now())
      .run();
    await syncSwipes(
      env,
      user,
      cards.map((card, i) => ({
        id: crypto.randomUUID(),
        word: card.word,
        verdict: (i ? -1 : 1) as 1 | -1,
        bucket: 'wild' as const,
        shownAt: yesterday,
        swipedAt: yesterday,
      })),
    );
    await env.APP.prepare('UPDATE swipe SET received_at=? WHERE user_id=?')
      .bind(yesterday, user)
      .run();
    const report = await buildNightlyStats(env);
    expect(report.periods[30].total.total).toBe(105);
    expect(report.globalLikeRate).toBeGreaterThan(0);
    expect(Object.keys(report.periods[30].bucket)).toContain('wild');
    expect(Object.keys(report.periods[30].etymBand).length).toBeGreaterThan(0);
    expect(Object.keys(report.periods[30].shape).length).toBeGreaterThan(0);
    const admin = await SELF.fetch('http://localhost/api/admin/stats', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });
    expect(admin.status).toBe(200);
  });
});
