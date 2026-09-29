-- SQLite cannot add a non-constant default to a populated table. Rebuild only
-- word_stats, preserving every rating and assigning each row its own random key.
-- No table references word_stats; the WITHOUT ROWID layout is retained.
CREATE TABLE `__new_word_stats` (
  `card_id` text PRIMARY KEY NOT NULL,
  `likes` integer DEFAULT 0 NOT NULL,
  `dislikes` integer DEFAULT 0 NOT NULL,
  `prior` real NOT NULL,
  `score` real NOT NULL,
  `updated_at` integer NOT NULL,
  `pool_order` text DEFAULT (hex(randomblob(8))) NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `__new_word_stats` (card_id, likes, dislikes, prior, score, updated_at)
SELECT card_id, likes, dislikes, prior, score, updated_at FROM `word_stats`;
--> statement-breakpoint
DROP TABLE `word_stats`;
--> statement-breakpoint
ALTER TABLE `__new_word_stats` RENAME TO `word_stats`;
--> statement-breakpoint
CREATE INDEX `idx_word_stats_unrated` ON `word_stats` (("likes" + "dislikes"),"prior" DESC,`pool_order`);--> statement-breakpoint
CREATE INDEX `idx_word_stats_rec` ON `word_stats` ("score" DESC,`pool_order`) WHERE "word_stats"."likes" + "word_stats"."dislikes" >= 5 AND "word_stats"."score" >= 0.5;--> statement-breakpoint
CREATE INDEX `idx_word_stats_promising` ON `word_stats` ("score" DESC,`pool_order`) WHERE "word_stats"."likes" > 0 AND ("word_stats"."likes" + "word_stats"."dislikes" < 5 OR "word_stats"."score" < 0.55) AND ("word_stats"."likes" + "word_stats"."dislikes" < 15 OR "word_stats"."score" >= 0.5);
