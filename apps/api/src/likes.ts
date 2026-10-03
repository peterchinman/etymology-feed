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

/** Most card IDs one like-count request may ask for. */
export const MAX_LIKE_COUNT_IDS = 100;

/**
 * Current totals for a list of card IDs, keyed by ID. One query reads one
 * word_stats row per known ID through its primary key; unknown IDs count 0.
 */
export async function getLikeCounts(
  app: D1Database,
  ids: readonly string[],
): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const rows = await app
    .prepare(
      'SELECT card_id, likes FROM word_stats WHERE card_id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(ids))
    .all<{ card_id: string; likes: number }>();
  const found = new Map(rows.results.map((row) => [row.card_id, row.likes]));
  return Object.fromEntries(ids.map((id) => [id, found.get(id) ?? 0]));
}
