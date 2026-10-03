import { env } from 'cloudflare:test';

type Options = {
  anonymous?: boolean;
  status?: 'pending' | 'trusted';
  /** Pace credit banked now; defaults to the full burst. */
  credit?: number;
  /** Creation time, which is when pace credit starts to accrue. */
  createdAt?: number;
  /** When the banked credit was last settled; defaults to now. */
  creditAt?: number;
};

/**
 * Insert a user whose served record says the feed dealt these cards. By
 * default the user is a trusted rater with a full pace burst, so their swipes
 * count immediately, as an established reader's would (§6.6).
 */
export async function raterWith(cardIds: string[] = [], options: Options = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = options.createdAt ?? now;
  await env.APP.batch([
    env.APP.prepare(
      'INSERT INTO user (id,name,email,created_at,updated_at,is_anonymous) VALUES (?,?,?,?,?,?)',
    ).bind(
      id,
      'Test',
      `${id}@test.local`,
      createdAt,
      now,
      Number(options.anonymous ?? true),
    ),
    env.APP.prepare(
      'INSERT INTO rater (user_id,status,credit,credit_at,updated_at) VALUES (?,?,?,?,?)',
    ).bind(
      id,
      options.status ?? 'trusted',
      options.credit ?? Number(env.RATER_PACE_BURST),
      options.creditAt ?? now,
      now,
    ),
    env.APP.prepare(
      'INSERT INTO served (user_id,card_ids,count,updated_at,dealt_ids) VALUES (?,?,?,?,?)',
    ).bind(
      id,
      JSON.stringify(cardIds),
      cardIds.length,
      now,
      JSON.stringify(cardIds),
    ),
  ]);
  return id;
}

export async function stats(cardId: string) {
  return env.APP.prepare(
    'SELECT likes, dislikes, score FROM word_stats WHERE card_id = ?',
  )
    .bind(cardId)
    .first<{ likes: number; dislikes: number; score: number }>();
}

export async function raterOf(userId: string) {
  return env.APP.prepare(
    'SELECT status, rated, liked, credit FROM rater WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ status: string; rated: number; liked: number; credit: number }>();
}
