import { getCardsByIds } from './feed';

type ServedRow = { card_ids: string };

function unionServed(first: string[], second: string[], cap: number): string[] {
  return [...new Set([...first, ...second])].slice(-cap);
}

/** Move an anonymous history into an account before Better Auth deletes the guest. */
export async function mergeAnonymousAccount(
  env: CloudflareBindings,
  anonymousId: string,
  accountId: string,
): Promise<void> {
  if (anonymousId === accountId) return;
  // Both lookups use served.user_id PK. Keep the account's order first, then
  // append cards first seen on this device.
  const served = await env.APP.batch([
    env.APP.prepare('SELECT card_ids FROM served WHERE user_id=?').bind(
      accountId,
    ),
    env.APP.prepare('SELECT card_ids FROM served WHERE user_id=?').bind(
      anonymousId,
    ),
  ]);
  const accountIds = JSON.parse(
    (served[0].results[0] as ServedRow | undefined)?.card_ids ?? '[]',
  ) as string[];
  const anonymousIds = JSON.parse(
    (served[1].results[0] as ServedRow | undefined)?.card_ids ?? '[]',
  ) as string[];
  const merged = unionServed(accountIds, anonymousIds, Number(env.SERVED_CAP));
  const dislikeWeight = Number(env.DISLIKE_WEIGHT);
  const now = Date.now();
  // One loser per conflicting card disappears from the aggregate. The target
  // row remains when it is newer; otherwise the guest row replaces it below.
  // idx_swipe_user_card serves both sides of the join; word_stats.card_id PK
  // serves the update. All writes run in one D1 transaction.
  const writes = [
    env.APP.prepare(`
      UPDATE word_stats AS stats SET
        likes=stats.likes-(loser.verdict=1),
        dislikes=stats.dislikes-(loser.verdict=-1),
        score=(stats.likes-(loser.verdict=1)+1.0)/
          (stats.likes-(loser.verdict=1)+
           (stats.dislikes-(loser.verdict=-1))*?+2.0),
        updated_at=?
      FROM (
        SELECT guest.card_id,
          CASE WHEN guest.swiped_at>member.swiped_at THEN member.verdict ELSE guest.verdict END AS verdict
        FROM swipe AS guest
        JOIN swipe AS member ON member.user_id=? AND member.card_id=guest.card_id
        WHERE guest.user_id=?
      ) AS loser
      WHERE stats.card_id=loser.card_id
    `).bind(dislikeWeight, now, accountId, anonymousId),
    // A conflicting guest row still owns its global swipe.id until it is
    // deleted, so update the member row in place and retain that row's ID.
    env.APP.prepare(`
      UPDATE swipe AS member SET
        verdict=guest.verdict, bucket=guest.bucket,
        shown_at=guest.shown_at, swiped_at=guest.swiped_at,
        received_at=guest.received_at
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
      INSERT INTO served(user_id,card_ids,count,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        card_ids=excluded.card_ids,count=excluded.count,updated_at=excluded.updated_at
    `).bind(accountId, JSON.stringify(merged), merged.length, now),
    env.APP.prepare('DELETE FROM served WHERE user_id=?').bind(anonymousId),
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
  const cards = await getCardsByIds(
    env.DICT,
    page.map((row) => row.card_id),
  );
  const likes = page.flatMap((row) => {
    const card = cards.get(row.card_id);
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
    `).bind(dislikeWeight, now, userId),
    env.APP.prepare('DELETE FROM user WHERE id=? AND is_anonymous=0').bind(
      userId,
    ),
  ]);
}
