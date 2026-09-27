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
  },
  (table) => [
    uniqueIndex('idx_swipe_user_card').on(table.userId, table.cardId),
    index('idx_swipe_user_liked')
      .on(table.userId, table.swipedAt)
      .where(sql`${table.verdict} = 1`),
    check('swipe_verdict_check', sql`${table.verdict} IN (1, -1)`),
  ],
);

export const served = sqliteTable('served', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  cardIds: text('card_ids').notNull(),
  count: integer('count').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const wordStats = sqliteTable(
  'word_stats',
  {
    cardId: text('card_id').primaryKey(),
    likes: integer('likes').notNull().default(0),
    dislikes: integer('dislikes').notNull().default(0),
    prior: real('prior').notNull(),
    score: real('score').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // Fresh lane: never-liked cards, fewest looks then best prior (§6.1).
    index('idx_word_stats_unrated').on(
      sql`(${table.likes} + ${table.dislikes})`,
      sql`${table.prior} DESC`,
    ),
    // Confirmed lane: at or above average with five looks; the query narrows
    // to CONFIRM_SCORE. Partial, so it costs writes only for qualifying rows.
    index('idx_word_stats_rec')
      .on(sql`${table.score} DESC`)
      .where(
        sql`${table.likes} + ${table.dislikes} >= 5 AND ${table.score} >= 0.5`,
      ),
    // Promising lane: liked, and neither confirmed (5 looks, score >= 0.55)
    // nor parked (15 looks, score < 0.5). Parking waits for three times the
    // evidence because it is the irreversible call (§6.1).
    index('idx_word_stats_promising')
      .on(sql`${table.score} DESC`)
      .where(
        sql`${table.likes} > 0 AND (${table.likes} + ${table.dislikes} < 5 OR ${table.score} < 0.55) AND (${table.likes} + ${table.dislikes} < 15 OR ${table.score} >= 0.5)`,
      ),
  ],
);
