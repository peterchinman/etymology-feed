DROP INDEX `idx_word_stats_score`;--> statement-breakpoint
DROP INDEX `idx_word_stats_unrated`;--> statement-breakpoint
CREATE INDEX `idx_word_stats_rec` ON `word_stats` ("score" DESC) WHERE "word_stats"."likes" + "word_stats"."dislikes" >= 5 AND "word_stats"."score" >= 0.5;--> statement-breakpoint
CREATE INDEX `idx_word_stats_score` ON `word_stats` ("score" DESC);--> statement-breakpoint
CREATE INDEX `idx_word_stats_unrated` ON `word_stats` (("likes" + "dislikes"),"prior" DESC);