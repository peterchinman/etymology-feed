import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth-schema';

export * from './auth-schema';

export const swipe = sqliteTable(
  'swipe',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    verdict: integer('verdict').notNull(),
    bucket: text('bucket'),
    shownAt: integer('shown_at').notNull(),
    swipedAt: integer('swiped_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    // 1 when the feed itself dealt this card to the user before the swipe.
    // Search results and recovered cookie-loss history are never dealt.
    dealt: integer('dealt').notNull().default(0),
    // Whether word_stats includes this verdict: 0 ignored, 1 counted, 2 held
    // until the user's rater record is trusted (see raters.ts).
    tally: integer('tally').notNull().default(0),
  },
  (table) => [
    uniqueIndex('idx_swipe_user_card').on(table.userId, table.cardId),
    index('idx_swipe_user_liked')
      .on(table.userId, sql`${table.swipedAt} DESC`, sql`${table.id} DESC`)
      .where(sql`${table.verdict} = 1`),
    check('swipe_verdict_check', sql`${table.verdict} IN (1, -1)`),
  ],
);

export const served = sqliteTable('served', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Exclusion list: dealt cards plus client-reported history after cookie loss.
  cardIds: text('card_ids').notNull(),
  count: integer('count').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Only the feed writes this list. A swipe can count only on these cards.
  dealtIds: text('dealt_ids').notNull().default('[]'),
});

/**
 * Whether a user's swipes count toward word_stats (§6.6). One row per user who
 * has synced. Every writer of a user's swipe rows replaces `revision`, so a
 * sync that read stale state fails its compare-and-swap and retries.
 */
export const rater = sqliteTable(
  'rater',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['pending', 'trusted', 'flagging', 'flagged'],
    })
      .notNull()
      .default('pending'),
    // Swipes on dealt cards, and how many of those are likes.
    rated: integer('rated').notNull().default(0),
    liked: integer('liked').notNull().default(0),
    // Pace credit: one swipe per RATER_PACE_SECONDS, banked up to the burst.
    credit: real('credit').notNull().default(0),
    creditAt: integer('credit_at').notNull(),
    revision: text('revision').notNull().default(''),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // The cron applies manual flags; the partial index holds only those rows.
    index('idx_rater_flagging')
      .on(table.userId)
      .where(sql`${table.status} = 'flagging'`),
    check(
      'rater_status_check',
      sql`${table.status} IN ('pending', 'trusted', 'flagging', 'flagged')`,
    ),
  ],
);

export const wordStats = sqliteTable(
  'word_stats',
  {
    cardId: text('card_id').primaryKey(),
    likes: integer('likes').notNull().default(0),
    dislikes: integer('dislikes').notNull().default(0),
    prior: real('prior').notNull(),
    score: real('score').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Stable random tie-breaker, assigned on insert before any pool LIMIT.
    poolOrder: text('pool_order').notNull().default(sql`(hex(randomblob(8)))`),
  },
  (table) => [
    // Fresh lane: never-liked cards, fewest looks then best prior (§6.1).
    index('idx_word_stats_unrated').on(
      sql`(${table.likes} + ${table.dislikes})`,
      sql`${table.prior} DESC`,
      table.poolOrder,
    ),
    // Confirmed lane: at or above average with five looks; the query narrows
    // to CONFIRM_SCORE. Partial, so it costs writes only for qualifying rows.
    index('idx_word_stats_rec')
      .on(sql`${table.score} DESC`, table.poolOrder)
      .where(
        sql`${table.likes} + ${table.dislikes} >= 5 AND ${table.score} >= 0.5`,
      ),
    // Promising lane: liked, and neither confirmed (5 looks, score >= 0.55)
    // nor parked (15 looks, score < 0.5). Parking waits for three times the
    // evidence because it is the irreversible call (§6.1).
    index('idx_word_stats_promising')
      .on(sql`${table.score} DESC`, table.poolOrder)
      .where(
        sql`${table.likes} > 0 AND (${table.likes} + ${table.dislikes} < 5 OR ${table.score} < 0.55) AND (${table.likes} + ${table.dislikes} < 15 OR ${table.score} >= 0.5)`,
      ),
  ],
);
