/**
 * Which swipes count toward word_stats (§6.6).
 *
 * A swipe counts only if the feed dealt that card to the user, or it is a
 * like and RATER_COUNT_UNDEALT_LIKES is on (search likes arrive this way); the
 * user's pace credit covered it; and the user's rater record is trusted. New raters
 * are trusted once they have RATER_HOLD_SWIPES dealt swipes, which defaults to
 * zero; until then a dealt, paced swipe is held, and promotion applies every
 * held swipe at once. Once a rater has RATER_JUDGE_SWIPES dealt swipes, a like
 * rate above the ceiling flags them: their counted swipes are removed and
 * nothing they do counts again. Every swipe is still stored, so Liked lists
 * and account sync never depend on these rules.
 */

export const TALLY = { ignored: 0, counted: 1, held: 2 } as const;

export type RaterStatus = 'pending' | 'trusted' | 'flagging' | 'flagged';

export type RaterRow = {
  status: RaterStatus;
  rated: number;
  liked: number;
  credit: number;
  credit_at: number;
  revision: string;
};

export type RaterRules = {
  holdSwipes: number;
  judgeSwipes: number;
  maxLikeRate: number;
  paceSeconds: number;
  burst: number;
  /** Count likes on cards the feed did not deal, such as search likes. */
  countUndealtLikes: boolean;
};

export function raterRules(env: CloudflareBindings): RaterRules {
  return {
    holdSwipes: Number(env.RATER_HOLD_SWIPES),
    judgeSwipes: Number(env.RATER_JUDGE_SWIPES),
    maxLikeRate: Number(env.RATER_MAX_LIKE_RATE),
    paceSeconds: Number(env.RATER_PACE_SECONDS),
    burst: Number(env.RATER_PACE_BURST),
    countUndealtLikes: Number(env.RATER_COUNT_UNDEALT_LIKES) === 1,
  };
}

/** True once there is enough evidence and it shows liking nearly everything. */
export function likesEverything(
  rated: number,
  liked: number,
  rules: RaterRules,
): boolean {
  return rated >= rules.judgeSwipes && liked > rules.maxLikeRate * rated;
}

/**
 * Status after a change in counts. Flagging is one-way and does not depend on
 * whether the rater was still held, so batching swipes cannot change it.
 */
export function nextStatus(
  status: RaterStatus,
  rated: number,
  liked: number,
  rules: RaterRules,
): RaterStatus {
  if (status === 'flagging' || status === 'flagged') return 'flagged';
  if (likesEverything(rated, liked, rules)) return 'flagged';
  if (status === 'pending' && rated >= rules.holdSwipes) return 'trusted';
  return status;
}

/** Pace credit available now: it accrues with server time up to the burst. */
export function creditNow(rater: RaterRow, now: number, rules: RaterRules) {
  const earned =
    Math.max(0, now - rater.credit_at) / (rules.paceSeconds * 1000);
  return Math.min(rules.burst, rater.credit + earned);
}

const RATER_COLUMNS = 'status, rated, liked, credit, credit_at, revision';

/** Read a user's rater record, creating a pending one on first use. */
export async function readRater(
  env: CloudflareBindings,
  userId: string,
): Promise<RaterRow> {
  // rater.user_id PK: one row read.
  const select = env.APP.prepare(
    `SELECT ${RATER_COLUMNS} FROM rater WHERE user_id = ?`,
  ).bind(userId);
  const row = await select.first<RaterRow>();
  if (row) return row;
  // Credit accrues from the user's creation, so a new guest cannot spend
  // time it never waited. One row written, once per user.
  await env.APP.prepare(
    'INSERT INTO rater (user_id, credit_at, updated_at) SELECT id, created_at, ? FROM user WHERE id = ? ON CONFLICT DO NOTHING',
  )
    .bind(Date.now(), userId)
    .run();
  const created = await select.first<RaterRow>();
  if (!created) throw new Error('Cannot rate for a missing user.');
  return created;
}

/** An SQL condition every statement of one atomic change must satisfy. */
export type Guard = { sql: string; binds: unknown[] };

export const revisionGuard = (userId: string, revision: string): Guard => ({
  sql: 'EXISTS (SELECT 1 FROM rater WHERE user_id = ? AND revision = ?)',
  binds: [userId, revision],
});

export const statusGuard = (userId: string, status: RaterStatus): Guard => ({
  sql: 'EXISTS (SELECT 1 FROM rater WHERE user_id = ? AND status = ?)',
  binds: [userId, status],
});

/**
 * Add (sign 1) or remove (sign -1) every verdict a user holds in one tally
 * state. Uses idx_swipe_user_card for the user's rows and the word_stats PK.
 */
export function shiftStats(
  env: CloudflareBindings,
  userId: string,
  tally: number,
  sign: 1 | -1,
  guard: Guard,
  now: number,
): D1PreparedStatement {
  return env.APP.prepare(`
    UPDATE word_stats AS stats SET
      likes = stats.likes + change.likes,
      dislikes = stats.dislikes + change.dislikes,
      score = (stats.likes + change.likes + 1.0) /
        (stats.likes + change.likes + (stats.dislikes + change.dislikes) * ? + 2.0),
      updated_at = ?
    FROM (
      SELECT card_id, ? * (verdict = 1) AS likes, ? * (verdict = -1) AS dislikes
      FROM swipe WHERE user_id = ? AND tally = ?
    ) AS change
    WHERE stats.card_id = change.card_id AND ${guard.sql}
  `).bind(
    Number(env.DISLIKE_WEIGHT),
    now,
    sign,
    sign,
    userId,
    tally,
    ...guard.binds,
  );
}

/** Move a user's swipes from some tally states to another. */
export function setTally(
  env: CloudflareBindings,
  userId: string,
  from: number[],
  to: number,
  guard: Guard,
): D1PreparedStatement {
  return env.APP.prepare(
    `UPDATE swipe SET tally = ? WHERE user_id = ? AND tally IN (${from.map(() => '?').join(',')}) AND ${guard.sql}`,
  ).bind(to, userId, ...from, ...guard.binds);
}

/** Statements that apply a user's held swipes once they become trusted. */
export function promote(
  env: CloudflareBindings,
  userId: string,
  guard: Guard,
  now: number,
): D1PreparedStatement[] {
  return [
    shiftStats(env, userId, TALLY.held, 1, guard, now),
    setTally(env, userId, [TALLY.held], TALLY.counted, guard),
  ];
}

/** Statements that remove everything a user counts or holds. */
export function demote(
  env: CloudflareBindings,
  userId: string,
  guard: Guard,
  now: number,
): D1PreparedStatement[] {
  return [
    shiftStats(env, userId, TALLY.counted, -1, guard, now),
    setTally(env, userId, [TALLY.counted, TALLY.held], TALLY.ignored, guard),
  ];
}

/**
 * Apply flags set by hand (status 'flagging') for users who may never sync
 * again. Runs from the five-minute cron; idx_rater_flagging bounds the read.
 */
export async function applyRequestedFlags(
  env: CloudflareBindings,
): Promise<number> {
  const { results } = await env.APP.prepare(
    "SELECT user_id FROM rater WHERE status = 'flagging' LIMIT 50",
  ).all<{ user_id: string }>();
  for (const { user_id: userId } of results) {
    const now = Date.now();
    const guard = statusGuard(userId, 'flagging');
    await env.APP.batch([
      ...demote(env, userId, guard, now),
      env.APP.prepare(
        "UPDATE rater SET status = 'flagged', revision = ?, updated_at = ? WHERE user_id = ? AND status = 'flagging'",
      ).bind(crypto.randomUUID(), now, userId),
    ]);
  }
  return results.length;
}
