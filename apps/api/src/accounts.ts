import { getCardsByIds } from './feed';
import { getLikeCounts } from './likes';
import {
  demote,
  promote,
  type RaterStatus,
  raterRules,
  statusGuard,
} from './raters';

type ServedRow = { card_ids: string; dealt_ids: string };

function unionServed(first: string[], second: string[], cap: number): string[] {
  return [...new Set([...first, ...second])].slice(-cap);
}

/** Flagged wins, then trusted: earned trust survives signing in elsewhere. */
function mergedStatus(
  ...statuses: (RaterStatus | undefined)[]
): 'flagged' | 'trusted' | 'pending' {
  if (statuses.some((status) => status === 'flagged' || status === 'flagging'))
    return 'flagged';
  return statuses.includes('trusted') ? 'trusted' : 'pending';
}

/** Move an anonymous history into an account before Better Auth deletes the guest. */
export async function mergeAnonymousAccount(
  env: CloudflareBindings,
  anonymousId: string,
  accountId: string,
): Promise<void> {
  if (anonymousId === accountId) return;
  // served.user_id and rater.user_id PKs: four row reads. Keep the account's
  // order first, then append cards first seen on this device.
  const reads = await env.APP.batch([
    env.APP.prepare(
      'SELECT card_ids, dealt_ids FROM served WHERE user_id=?',
    ).bind(accountId),
    env.APP.prepare(
      'SELECT card_ids, dealt_ids FROM served WHERE user_id=?',
    ).bind(anonymousId),
    env.APP.prepare('SELECT status FROM rater WHERE user_id=?').bind(accountId),
    env.APP.prepare('SELECT status FROM rater WHERE user_id=?').bind(
      anonymousId,
    ),
  ]);
  const [account, guest] = [0, 1].map(
    (i) => reads[i].results[0] as ServedRow | undefined,
  );
  const ids = (row: ServedRow | undefined, column: keyof ServedRow) =>
    JSON.parse(row?.[column] ?? '[]') as string[];
  const cap = Number(env.SERVED_CAP);
  const merged = unionServed(
    ids(account, 'card_ids'),
    ids(guest, 'card_ids'),
    cap,
  );
  const dealt = unionServed(
    ids(account, 'dealt_ids'),
    ids(guest, 'dealt_ids'),
    cap,
  );
  const base = mergedStatus(
    ...[2, 3].map(
      (i) =>
        (reads[i].results[0] as { status: RaterStatus } | undefined)?.status,
    ),
  );
  const rules = raterRules(env);
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  const now = Date.now();
  // One loser per conflicting card disappears from the aggregate, if it was
  // counted. The target row remains when it is newer; otherwise the guest
  // row replaces it below. idx_swipe_user_card serves both sides of the join;
  // word_stats.card_id PK serves the update. All writes run in one D1
  // transaction.
  const writes = [
    // The account inherits the guest's pace credit when it has no record yet.
    env.APP.prepare(`
      INSERT INTO rater (user_id, credit, credit_at, updated_at)
      SELECT ?, credit, credit_at, ? FROM rater WHERE user_id = ?
      ON CONFLICT DO NOTHING
    `).bind(accountId, now, anonymousId),
    env.APP.prepare(`
      INSERT INTO rater (user_id, credit_at, updated_at)
      SELECT id, created_at, ? FROM user WHERE id = ? ON CONFLICT DO NOTHING
    `).bind(now, accountId),
    env.APP.prepare(`
      UPDATE word_stats AS stats SET
        likes=stats.likes-(loser.verdict=1),
        dislikes=stats.dislikes-(loser.verdict=-1),
        score=(stats.likes-(loser.verdict=1)+1.0)/
          (stats.likes-(loser.verdict=1)+
           (stats.dislikes-(loser.verdict=-1))*?+2.0),
        updated_at=?
      FROM (
        SELECT card_id, verdict FROM (
          SELECT guest.card_id,
            CASE WHEN guest.swiped_at>member.swiped_at THEN member.verdict ELSE guest.verdict END AS verdict,
            CASE WHEN guest.swiped_at>member.swiped_at THEN member.tally ELSE guest.tally END AS tally
          FROM swipe AS guest
          JOIN swipe AS member ON member.user_id=? AND member.card_id=guest.card_id
          WHERE guest.user_id=?
        ) WHERE tally=1
      ) AS loser
      WHERE stats.card_id=loser.card_id
    `).bind(dislikeWeight, now, accountId, anonymousId),
    // A conflicting guest row still owns its global swipe.id until it is
    // deleted, so update the member row in place and retain that row's ID.
    env.APP.prepare(`
      UPDATE swipe AS member SET
        verdict=guest.verdict, bucket=guest.bucket,
        shown_at=guest.shown_at, swiped_at=guest.swiped_at,
        received_at=guest.received_at, dealt=guest.dealt, tally=guest.tally
      FROM swipe AS guest
      WHERE member.user_id=? AND guest.user_id=?
        AND member.card_id=guest.card_id
        AND guest.swiped_at>member.swiped_at
    `).bind(accountId, anonymousId),
    // Nonconflicting rows can keep their original client idempotency key.
    env.APP.prepare(`
      UPDATE swipe SET user_id=? WHERE user_id=?
        AND card_id NOT IN (SELECT card_id FROM swipe WHERE user_id=?)
    `).bind(accountId, anonymousId, accountId),
    env.APP.prepare('DELETE FROM swipe WHERE user_id=?').bind(anonymousId),
    env.APP.prepare(`
      INSERT INTO served(user_id,card_ids,count,updated_at,dealt_ids) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        card_ids=excluded.card_ids,count=excluded.count,updated_at=excluded.updated_at,
        dealt_ids=excluded.dealt_ids
    `).bind(
      accountId,
      JSON.stringify(merged),
      merged.length,
      now,
      JSON.stringify(dealt),
    ),
    env.APP.prepare('DELETE FROM served WHERE user_id=?').bind(anonymousId),
    // Recount the merged history, then judge it as one rater (§6.6). A new
    // revision makes any sync that read either history retry.
    env.APP.prepare(`
      UPDATE rater SET
        rated = (SELECT count(*) FROM swipe WHERE user_id = ?1 AND dealt = 1),
        liked = (SELECT count(*) FROM swipe WHERE user_id = ?1 AND dealt = 1 AND verdict = 1),
        revision = ?2, updated_at = ?3
      WHERE user_id = ?1
    `).bind(accountId, crypto.randomUUID(), now),
    // Same rules as nextStatus in raters.ts, on the merged counts.
    env.APP.prepare(`
      UPDATE rater SET status = CASE
        WHEN ?2 = 'flagged' OR (rated >= ?3 AND liked > ?4 * rated) THEN 'flagged'
        WHEN ?2 = 'trusted' OR rated >= ?5 THEN 'trusted'
        ELSE 'pending'
      END
      WHERE user_id = ?1
    `).bind(
      accountId,
      base,
      rules.judgeSwipes,
      rules.maxLikeRate,
      rules.holdSwipes,
    ),
    // Settle tallies for the final status. Each pair no-ops otherwise.
    ...promote(env, accountId, statusGuard(accountId, 'trusted'), now),
    ...demote(env, accountId, statusGuard(accountId, 'flagged'), now),
  ];
  await env.APP.batch(writes);
}

type LikedRow = {
  id: string;
  card_id: string;
  bucket: string | null;
  shown_at: number;
  swiped_at: number;
};

export async function getAccountLikes(
  env: CloudflareBindings,
  userId: string,
  limit: number,
  cursor?: { swipedAt: number; id: string },
) {
  // idx_swipe_user_liked bounds the page to limit+1 rows; DICT lookups use
  // word.id PK through one JSON-array parameter.
  const rows = await env.APP.prepare(`
    SELECT id,card_id,bucket,shown_at,swiped_at FROM swipe
    WHERE user_id=? AND verdict=1
      AND (? IS NULL OR swiped_at<? OR (swiped_at=? AND id<?))
    ORDER BY swiped_at DESC,id DESC LIMIT ?
  `)
    .bind(
      userId,
      cursor?.swipedAt ?? null,
      cursor?.swipedAt ?? null,
      cursor?.swipedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<LikedRow>();
  const page = rows.results.slice(0, limit);
  const ids = page.map((row) => row.card_id);
  // Totals are read after this user's likes are stored, so they include the
  // ones that counted (§6.6).
  const [cards, counts] = await Promise.all([
    getCardsByIds(env.DICT, ids),
    getLikeCounts(env.APP, ids),
  ]);
  const likes = page.flatMap((row) => {
    const found = cards.get(row.card_id);
    const card = found && { ...found, likeCount: counts[row.card_id] ?? 0 };
    return card
      ? [
          {
            id: row.id,
            cardId: row.card_id,
            word: card.word,
            bucket: row.bucket,
            shownAt: row.shown_at,
            swipedAt: row.swiped_at,
            card,
          },
        ]
      : [];
  });
  const last = page.at(-1);
  return {
    likes,
    nextCursor:
      rows.results.length > limit && last
        ? btoa(JSON.stringify([last.swiped_at, last.id]))
        : null,
  };
}

/** Remove a registered user and their aggregate contributions atomically. */
export async function deleteAccount(
  env: CloudflareBindings,
  userId: string,
): Promise<void> {
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  const now = Date.now();
  await env.APP.batch([
    env.APP.prepare(`
      UPDATE word_stats AS stats SET
        likes=stats.likes-(swipe.verdict=1),
        dislikes=stats.dislikes-(swipe.verdict=-1),
        score=(stats.likes-(swipe.verdict=1)+1.0)/
          (stats.likes-(swipe.verdict=1)+
           (stats.dislikes-(swipe.verdict=-1))*?+2.0),
        updated_at=?
      FROM swipe WHERE swipe.user_id=? AND swipe.card_id=stats.card_id
        AND swipe.tally=1
    `).bind(dislikeWeight, now, userId),
    env.APP.prepare('DELETE FROM user WHERE id=? AND is_anonymous=0').bind(
      userId,
    ),
  ]);
}
