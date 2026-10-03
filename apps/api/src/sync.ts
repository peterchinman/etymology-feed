import { z } from 'zod';
import {
  creditNow,
  demote,
  nextStatus,
  promote,
  raterRules,
  readRater,
  revisionGuard,
  TALLY,
} from './raters';

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
type OldSwipe = {
  id: string;
  verdict: number;
  swiped_at: number;
  dealt: number;
  tally: number;
};

/** Another request changed this user's swipes during every attempt. */
export class SyncConflict extends Error {}

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
  const rules = raterRules(env);
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
  if (!valid.length) return { results, rowsWritten: 0 };

  for (let attempt = 0; attempt < 3; attempt++) {
    // Read the rater first. Every writer of this user's swipes replaces its
    // revision, so if the reads below go stale the final swap fails.
    const rater = await readRater(env, userId);
    // PK/unique lookups: at most two APP rows per swipe, plus served by PK.
    const reads = await env.APP.batch([
      ...valid.map(({ item }) =>
        env.APP.prepare(
          'SELECT id, verdict, swiped_at, dealt, tally FROM swipe WHERE user_id = ? AND card_id = ?',
        ).bind(userId, item.cardId),
      ),
      ...valid.map(({ item }) =>
        env.APP.prepare(
          'SELECT likes, dislikes FROM word_stats WHERE card_id = ?',
        ).bind(item.cardId),
      ),
      env.APP.prepare('SELECT dealt_ids FROM served WHERE user_id = ?').bind(
        userId,
      ),
    ]);
    const servedRow = reads[valid.length * 2].results[0] as
      | { dealt_ids: string }
      | undefined;
    const dealtIds = new Set<string>(
      JSON.parse(servedRow?.dealt_ids ?? '[]') as string[],
    );
    const applied: {
      item: SwipeInput;
      old?: OldSwipe;
      dealt: boolean;
      eligible: boolean;
      paced: boolean;
    }[] = [];
    for (const [i, { item, index }] of valid.entries()) {
      const old = reads[i].results[0] as OldSwipe | undefined;
      if (old?.id === item.id || (old && old.swiped_at >= item.swipedAt)) {
        results[index] = { id: item.id, status: 'duplicate' };
        continue;
      }
      if (!reads[valid.length + i].results[0]) {
        results[index] = {
          id: item.id,
          status: 'invalid',
          message: 'Card is not in the statistics table.',
        };
        continue;
      }
      const dealt = dealtIds.has(item.cardId);
      applied.push({
        item,
        old,
        dealt,
        // The server cannot tell a search like from any other like on a card
        // it did not deal. Lefts on such cards never count, so they cannot
        // bury a card.
        eligible: dealt || (rules.countUndealtLikes && item.verdict === 1),
        paced: false,
      });
      results[index] = { id: item.id, status: 'synced' };
    }
    if (!applied.length) return { results, rowsWritten: 0 };

    // Spend pace credit in swipe order, so an offline backlog keeps its
    // earliest swipes. The like rate covers dealt cards only: a search like
    // is a like by construction, so counting it there would penalize readers
    // who search.
    const now = Date.now();
    let credit = creditNow(rater, now, rules);
    let rated = rater.rated;
    let liked = rater.liked;
    for (const swipe of [...applied].sort(
      (a, b) => a.item.swipedAt - b.item.swipedAt,
    )) {
      const { item, old, dealt, eligible } = swipe;
      rated += Number(dealt) - Number(old?.dealt === 1);
      liked +=
        Number(dealt && item.verdict === 1) -
        Number(old?.dealt === 1 && old.verdict === 1);
      if (eligible && credit >= 1) {
        credit -= 1;
        swipe.paced = true;
      }
    }
    const status = nextStatus(rater.status, rated, liked, rules);
    const revision = crypto.randomUUID();
    const guard = revisionGuard(userId, revision);
    const writes: D1PreparedStatement[] = [
      env.APP.prepare(
        'UPDATE rater SET status = ?, rated = ?, liked = ?, credit = ?, credit_at = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?',
      ).bind(
        status,
        rated,
        liked,
        credit,
        now,
        revision,
        now,
        userId,
        rater.revision,
      ),
    ];
    // Status changes settle existing rows first; each swipe below then
    // replaces its card's current row with the new status already in place.
    if (status === 'trusted' && rater.status !== 'trusted')
      writes.push(...promote(env, userId, guard, now));
    if (status === 'flagged' && rater.status !== 'flagged')
      writes.push(...demote(env, userId, guard, now));
    const tallyNow =
      status === 'trusted'
        ? TALLY.counted
        : status === 'pending'
          ? TALLY.held
          : TALLY.ignored;
    for (const { item, dealt, eligible, paced } of applied) {
      const tally = eligible && paced ? tallyNow : TALLY.ignored;
      const counted = tally === TALLY.counted;
      // D1 runs the batch as one transaction in order. Read the card's current
      // swipe inside it, so the change is exact even without the swap above.
      writes.push(
        env.APP.prepare(`
          WITH incoming(card_id, user_id, id, swiped_at, likes, dislikes) AS (VALUES (?, ?, ?, ?, ?, ?)),
          change AS (
            SELECT incoming.card_id,
              incoming.likes - COALESCE(current.tally = 1 AND current.verdict = 1, 0) AS likes,
              incoming.dislikes - COALESCE(current.tally = 1 AND current.verdict = -1, 0) AS dislikes
            FROM incoming LEFT JOIN swipe AS current
              ON current.user_id = incoming.user_id AND current.card_id = incoming.card_id
            WHERE current.id IS NULL OR
              (current.id <> incoming.id AND current.swiped_at < incoming.swiped_at)
          )
          UPDATE word_stats AS stats SET
            likes = stats.likes + change.likes,
            dislikes = stats.dislikes + change.dislikes,
            score = (stats.likes + change.likes + 1.0) /
              (stats.likes + change.likes + (stats.dislikes + change.dislikes) * ? + 2.0),
            updated_at = ?
          FROM change
          WHERE stats.card_id = change.card_id
            AND (change.likes <> 0 OR change.dislikes <> 0) AND ${guard.sql}
        `).bind(
          item.cardId,
          userId,
          item.id,
          item.swipedAt,
          Number(counted && item.verdict === 1),
          Number(counted && item.verdict === -1),
          dislikeWeight,
          now,
          ...guard.binds,
        ),
      );
      // The stats change above saw the previous swipe; this upsert applies
      // the same timestamp guard. Uncounted swipes are stored all the same.
      writes.push(
        env.APP.prepare(`
          INSERT INTO swipe (id, user_id, card_id, verdict, bucket, shown_at, swiped_at, received_at, dealt, tally)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
          ON CONFLICT(user_id, card_id) DO UPDATE SET
            id = excluded.id, verdict = excluded.verdict, bucket = excluded.bucket,
            shown_at = excluded.shown_at, swiped_at = excluded.swiped_at,
            received_at = excluded.received_at, dealt = excluded.dealt, tally = excluded.tally
          WHERE swipe.id <> excluded.id AND swipe.swiped_at < excluded.swiped_at
        `).bind(
          item.id,
          userId,
          item.cardId,
          item.verdict,
          item.bucket ?? null,
          item.shownAt,
          item.swipedAt,
          now,
          Number(dealt),
          tally,
          ...guard.binds,
        ),
      );
    }
    const written = await env.APP.batch(writes);
    // Another writer replaced the revision after our reads: nothing applied.
    if (written[0].meta.changes !== 1) continue;
    let servedWritten = 0;
    // Normally every synced card is already in served. Cookie-loss recovery
    // can add missing card IDs with a single extra write for the whole batch.
    // These IDs only prevent repeats; they never become dealt.
    const record = await env.APP.prepare(
      'SELECT card_ids FROM served WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ card_ids: string }>();
    const ids: string[] = record ? JSON.parse(record.card_ids) : [];
    const seen = new Set(ids);
    for (const { item } of applied)
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
    return {
      results,
      rowsWritten:
        servedWritten +
        written.reduce((total, result) => total + result.meta.rows_written, 0),
    };
  }
  throw new SyncConflict('Concurrent syncs need a retry.');
}

export async function deleteLiked(
  env: CloudflareBindings,
  userId: string,
  cardId: string,
): Promise<boolean> {
  const now = Date.now();
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  const liked =
    'SELECT dealt FROM swipe WHERE user_id = ? AND card_id = ? AND verdict = 1';
  const writes = await env.APP.batch([
    env.APP.prepare(
      `UPDATE word_stats SET
        likes=likes-1,score=likes/(likes+1.0+dislikes*?),updated_at=?
       WHERE card_id=? AND EXISTS (
         SELECT 1 FROM swipe WHERE user_id=? AND card_id=? AND verdict=1 AND tally=1
       )`,
    ).bind(dislikeWeight, now, cardId, userId, cardId),
    // An un-like leaves the like rate too. Replacing the revision makes a
    // concurrent sync that read this swipe retry instead of using stale counts.
    env.APP.prepare(
      `UPDATE rater SET rated = rated - (${liked}), liked = liked - (${liked}),
        revision = ?, updated_at = ?
       WHERE user_id = ? AND EXISTS (${liked})`,
    ).bind(
      userId,
      cardId,
      userId,
      cardId,
      crypto.randomUUID(),
      now,
      userId,
      userId,
      cardId,
    ),
    env.APP.prepare(
      'DELETE FROM swipe WHERE user_id=? AND card_id=? AND verdict=1',
    ).bind(userId, cardId),
  ]);
  return writes[2].meta.changes === 1;
}
