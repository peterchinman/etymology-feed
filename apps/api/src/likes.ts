import type { Card } from '@etymology-feed/shared/card';

/** Read current totals by card ID, including separate origins of a headword. */
export async function withLikeCounts(app: D1Database, cards: Card[]) {
  if (!cards.length) return { cards, rowsRead: 0 };
  // One indexed statistics lookup per card, sent in a single database call.
  // Read APP directly so totals do not depend on the ranking pool cache.
  const results = await app.batch<{ likes: number }>(
    cards.map(({ id }) =>
      app.prepare('SELECT likes FROM word_stats WHERE card_id = ?').bind(id),
    ),
  );
  return {
    cards: cards.map((card, index) => ({
      ...card,
      likeCount: results[index].results[0]?.likes ?? 0,
    })),
    rowsRead: results.reduce(
      (total, result) => total + result.meta.rows_read,
      0,
    ),
  };
}
