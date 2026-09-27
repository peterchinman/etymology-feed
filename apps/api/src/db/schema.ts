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
    // Fresh lane: n = 0 ordered by the heuristic prior (§6.1).
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
    // Promising lane: at least one like and under five looks. No dislike test;
    // a like buys the card its five looks (§6.1).
    index('idx_word_stats_promising')
      .on(sql`${table.score} DESC`)
      .where(
        sql`${table.likes} > 0 AND ${table.likes} + ${table.dislikes} < 5`,
      ),
  ],
);
