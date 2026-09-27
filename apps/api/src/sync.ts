import { z } from 'zod';

export const swipeInput = z
  .object({
    id: z.uuid(),
    cardId: z.string().min(1).max(200).optional(),
    word: z.string().min(1).max(200).optional(), // older offline clients send the primary card's word
    verdict: z.union([z.literal(1), z.literal(-1)]),
    // Legacy 'rec' and 'unknown' may still arrive from offline queues filled
    // before the lane feed shipped.
    bucket: z
      .enum(['confirmed', 'promising', 'fresh', 'wild', 'rec', 'unknown'])
      .nullable()
      .optional(),
    shownAt: z.number().int().nonnegative(),
    swipedAt: z.number().int().nonnegative(),
  })
  .refine((item) => item.cardId || item.word)
  .transform((item) => ({
    ...item,
    cardId: item.cardId ?? item.word ?? '',
  }));
export const syncInput = z.object({ swipes: z.array(z.unknown()).max(500) });
export type SwipeInput = z.infer<typeof swipeInput>;
type OldSwipe = { id: string; verdict: number; swiped_at: number };
type WordStat = { likes: number; dislikes: number };

export async function syncSwipes(
  env: CloudflareBindings,
  userId: string,
  items: unknown[],
) {
  type ItemResult = {
    id: string;
    status: 'synced' | 'duplicate' | 'invalid';
    message?: string;
  };
  const results: ItemResult[] = items.map((item) => ({
    id: typeof item === 'object' && item && 'id' in item ? String(item.id) : '',
    status: 'invalid',
    message: 'Invalid swipe.',
  }));
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  const now = Date.now();
  const distinct = new Set<string>();
  const parsed: { item: SwipeInput; index: number }[] = [];
  for (const [index, item] of items.entries()) {
    const check = swipeInput.safeParse(item);
    if (check.success) parsed.push({ item: check.data, index });
  }
  const latestByCard = new Map<string, { index: number; swipedAt: number }>();
  for (const { item, index } of parsed) {
    const latest = latestByCard.get(item.cardId);
    if (!latest || latest.swipedAt <= item.swipedAt)
      latestByCard.set(item.cardId, { index, swipedAt: item.swipedAt });
  }
  const valid = parsed.filter(({ item, index }) => {
    if (
      distinct.has(item.id) ||
      latestByCard.get(item.cardId)?.index !== index
    ) {
      results[index] = { id: item.id, status: 'duplicate' };
      return false;
    }
    distinct.add(item.id);
    return true;
  });
  // Both lookups use PK/unique indexes: at most two APP rows per swipe.
  const oldRows = valid.length
    ? await env.APP.batch(
        valid.map(({ item }) =>
          env.APP.prepare(
            'SELECT id, verdict, swiped_at FROM swipe WHERE user_id = ? AND card_id = ?',
          ).bind(userId, item.cardId),
        ),
      )
    : [];
  const stats = valid.length
    ? await env.APP.batch(
        valid.map(({ item }) =>
          env.APP.prepare(
            'SELECT likes, dislikes FROM word_stats WHERE card_id = ?',
          ).bind(item.cardId),
        ),
      )
    : [];
  const writes: D1PreparedStatement[] = [];
  const applied: SwipeInput[] = [];
  for (let i = 0; i < valid.length; i++) {
    const { item, index } = valid[i];
    const old = oldRows[i].results[0] as OldSwipe | undefined;
    const stat = stats[i].results[0] as WordStat | undefined;
    if (old?.id === item.id || (old && old.swiped_at >= item.swipedAt)) {
      results[index] = { id: item.id, status: 'duplicate' };
      continue;
    }
    if (!stat) {
      results[index] = {
        id: item.id,
        status: 'invalid',
        message: 'Card is not in the statistics table.',
      };
      continue;
    }
    const likeDelta =
      (item.verdict === 1 ? 1 : 0) - (old?.verdict === 1 ? 1 : 0);
    const dislikeDelta =
      (item.verdict === -1 ? 1 : 0) - (old?.verdict === -1 ? 1 : 0);
    // UNIQUE(user_id,card_id) and id PK: one swipe row, then one stats row.
    writes.push(
      env.APP.prepare(
        'INSERT INTO swipe (id,user_id,card_id,verdict,bucket,shown_at,swiped_at,received_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,card_id) DO UPDATE SET id=excluded.id,verdict=excluded.verdict,bucket=excluded.bucket,shown_at=excluded.shown_at,swiped_at=excluded.swiped_at,received_at=excluded.received_at',
      ).bind(
        item.id,
        userId,
        item.cardId,
        item.verdict,
        item.bucket ?? null,
        item.shownAt,
        item.swipedAt,
        now,
      ),
    );
    // PK card_id: one row written. SET expressions see the pre-update row, so
    // the deltas are added explicitly. Score is the weighted-left posterior
    // mean (§6.2): (likes + 1) / (likes + w * dislikes + 2); the heuristic
    // prior orders only the fresh lane.
    writes.push(
      env.APP.prepare(
        'UPDATE word_stats SET likes=likes+?, dislikes=dislikes+?, score=(likes+?+1.0)/(likes+?+(dislikes+?)*?+2.0), updated_at=? WHERE card_id=?',
      ).bind(
        likeDelta,
        dislikeDelta,
        likeDelta,
        likeDelta,
        dislikeDelta,
        dislikeWeight,
        now,
        item.cardId,
      ),
    );
    applied.push(item);
    results[index] = { id: item.id, status: 'synced' };
  }
  const written = writes.length ? await env.APP.batch(writes) : [];
  let servedWritten = 0;
  // Normally every synced card is already in served. Cookie-loss recovery can
  // add missing card IDs with a single extra write for the whole batch.
  if (applied.length) {
    const record = await env.APP.prepare(
      'SELECT card_ids FROM served WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ card_ids: string }>();
    const ids: string[] = record ? JSON.parse(record.card_ids) : [];
    const seen = new Set(ids);
    for (const item of applied)
      if (!seen.has(item.cardId)) {
        seen.add(item.cardId);
        ids.push(item.cardId);
      }
    if (!record || seen.size !== new Set(JSON.parse(record.card_ids)).size) {
      const capped = ids.slice(-Number(env.SERVED_CAP));
      const updated = await env.APP.prepare(
        'INSERT INTO served (user_id,card_ids,count,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET card_ids=excluded.card_ids,count=excluded.count,updated_at=excluded.updated_at',
      )
        .bind(userId, JSON.stringify(capped), capped.length, now)
        .run();
      servedWritten = updated.meta.rows_written;
    }
  }
  return {
    results,
    rowsWritten:
      servedWritten +
      written.reduce((total, result) => total + result.meta.rows_written, 0),
  };
}

export async function deleteLiked(
  env: CloudflareBindings,
  userId: string,
  cardId: string,
): Promise<boolean> {
  // UNIQUE(user_id,card_id): one row read.
  const old = await env.APP.prepare(
    'SELECT verdict FROM swipe WHERE user_id=? AND card_id=?',
  )
    .bind(userId, cardId)
    .first<{ verdict: number }>();
  if (old?.verdict !== 1) return false;
  const now = Date.now();
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  await env.APP.batch([
    env.APP.prepare(
      'DELETE FROM swipe WHERE user_id=? AND card_id=? AND verdict=1',
    ).bind(userId, cardId),
    // (likes - 1 + 1) / (likes - 1 + w * dislikes + 2), pre-update values.
    env.APP.prepare(
      'UPDATE word_stats SET likes=likes-1,score=likes/(likes+1.0+dislikes*?),updated_at=? WHERE card_id=?',
    ).bind(dislikeWeight, now, cardId),
  ]);
  return true;
}
