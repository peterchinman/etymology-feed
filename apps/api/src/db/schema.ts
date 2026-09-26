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
    word: text('word').notNull(),
    verdict: integer('verdict').notNull(),
    bucket: text('bucket'),
    shownAt: integer('shown_at').notNull(),
    swipedAt: integer('swiped_at').notNull(),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_swipe_user_word').on(table.userId, table.word),
    index('idx_swipe_user_liked')
      .on(table.userId, table.swipedAt)
      .where(sql`${table.verdict} = 1`),
    index('idx_swipe_word').on(table.word),
    check('swipe_verdict_check', sql`${table.verdict} IN (1, -1)`),
  ],
);

export const served = sqliteTable('served', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  words: text('words').notNull(),
  count: integer('count').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const wordStats = sqliteTable(
  'word_stats',
  {
    word: text('word').primaryKey(),
    likes: integer('likes').notNull().default(0),
    dislikes: integer('dislikes').notNull().default(0),
    prior: real('prior').notNull(),
    score: real('score').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_word_stats_score').on(sql`${table.score} DESC`),
    index('idx_word_stats_unrated').on(
      sql`(${table.likes} + ${table.dislikes})`,
      sql`${table.prior} DESC`,
    ),
    index('idx_word_stats_rec')
      .on(sql`${table.score} DESC`)
      .where(
        sql`${table.likes} + ${table.dislikes} >= 5 AND ${table.score} >= 0.5`,
      ),
  ],
);
