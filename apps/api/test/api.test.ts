import { env, SELF } from 'cloudflare:test';
import type { Card } from '@etymology-feed/shared/card';
import { describe, expect, it } from 'vitest';
import { getWildFeed } from '../src/feed';

describe('read-only dictionary API', () => {
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
    expect(cards.every((card) => card.bucket === 'wild')).toBe(true);

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
});
