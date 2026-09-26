import { z } from 'zod';

export const swipeInput = z.object({
  id: z.uuid(),
  word: z.string().min(1).max(200),
  verdict: z.union([z.literal(1), z.literal(-1)]),
  bucket: z.enum(['rec', 'unknown', 'wild']).nullable().optional(),
  shownAt: z.number().int().nonnegative(),
  swipedAt: z.number().int().nonnegative(),
});
export const syncInput = z.object({ swipes: z.array(z.unknown()).max(500) });
export type SwipeInput = z.infer<typeof swipeInput>;
type OldSwipe = { id: string; verdict: number; swiped_at: number };
type WordStat = { likes: number; dislikes: number; prior: number };

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
  const strength = Number(env.PRIOR_STRENGTH);
  const now = Date.now();
  const distinct = new Set<string>();
  const parsed: { item: SwipeInput; index: number }[] = [];
  for (const [index, item] of items.entries()) {
    const check = swipeInput.safeParse(item);
    if (check.success) parsed.push({ item: check.data, index });
  }
  const latestByWord = new Map<string, { index: number; swipedAt: number }>();
  for (const { item, index } of parsed) {
    const latest = latestByWord.get(item.word);
    if (!latest || latest.swipedAt <= item.swipedAt)
      latestByWord.set(item.word, { index, swipedAt: item.swipedAt });
  }
  const valid = parsed.filter(({ item, index }) => {
    if (distinct.has(item.id) || latestByWord.get(item.word)?.index !== index) {
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
            'SELECT id, verdict, swiped_at FROM swipe WHERE user_id = ? AND word = ?',
          ).bind(userId, item.word),
        ),
      )
    : [];
  const stats = valid.length
    ? await env.APP.batch(
        valid.map(({ item }) =>
          env.APP.prepare(
            'SELECT likes, dislikes, prior FROM word_stats WHERE word = ?',
          ).bind(item.word),
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
        message: 'Word is not in the statistics table.',
      };
      continue;
    }
    const likeDelta =
      (item.verdict === 1 ? 1 : 0) - (old?.verdict === 1 ? 1 : 0);
    const dislikeDelta =
      (item.verdict === -1 ? 1 : 0) - (old?.verdict === -1 ? 1 : 0);
    // Composite PK(user_id,word) and unique id: one swipe row, then one stats row.
    writes.push(
      env.APP.prepare(
        'INSERT INTO swipe (id,user_id,word,verdict,bucket,shown_at,swiped_at,received_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,word) DO UPDATE SET id=excluded.id,verdict=excluded.verdict,bucket=excluded.bucket,shown_at=excluded.shown_at,swiped_at=excluded.swiped_at,received_at=excluded.received_at',
      ).bind(
        item.id,
        userId,
        item.word,
        item.verdict,
        item.bucket ?? null,
        item.shownAt,
        item.swipedAt,
        now,
      ),
    );
    // PK word: one row written. Compute from the current DB counters inside the transaction.
    writes.push(
      env.APP.prepare(
        'UPDATE word_stats SET likes=likes+?, dislikes=dislikes+?, score=(likes+?+?*prior)/(likes+dislikes+?+?+?), updated_at=? WHERE word=?',
      ).bind(
        likeDelta,
        dislikeDelta,
        likeDelta,
        strength,
        likeDelta,
        dislikeDelta,
        strength,
        now,
        item.word,
      ),
    );
    applied.push(item);
    results[index] = { id: item.id, status: 'synced' };
  }
  const written = writes.length ? await env.APP.batch(writes) : [];
  let servedWritten = 0;
  // Normally every synced card is already in served. Cookie-loss recovery can
  // add missing words with a single extra write for the whole batch.
  if (applied.length) {
    const record = await env.APP.prepare(
      'SELECT words FROM served WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ words: string }>();
    const words: string[] = record ? JSON.parse(record.words) : [];
    const seen = new Set(words);
    for (const item of applied)
      if (!seen.has(item.word)) {
        seen.add(item.word);
        words.push(item.word);
      }
    if (!record || seen.size !== new Set(JSON.parse(record.words)).size) {
      const capped = words.slice(-Number(env.SERVED_CAP));
      const updated = await env.APP.prepare(
        'INSERT INTO served (user_id,words,count,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET words=excluded.words,count=excluded.count,updated_at=excluded.updated_at',
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
  word: string,
): Promise<boolean> {
  // UNIQUE(user_id,word): one row read.
  const old = await env.APP.prepare(
    'SELECT verdict FROM swipe WHERE user_id=? AND word=?',
  )
    .bind(userId, word)
    .first<{ verdict: number }>();
  if (old?.verdict !== 1) return false;
  const now = Date.now();
  const strength = Number(env.PRIOR_STRENGTH);
  await env.APP.batch([
    env.APP.prepare(
      'DELETE FROM swipe WHERE user_id=? AND word=? AND verdict=1',
    ).bind(userId, word),
    env.APP.prepare(
      'UPDATE word_stats SET likes=likes-1,score=(likes-1+?*prior)/(likes+dislikes-1+?),updated_at=? WHERE word=?',
    ).bind(strength, strength, now, word),
  ]);
  return true;
}
