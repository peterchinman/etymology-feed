CREATE TABLE `rater` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rated` integer DEFAULT 0 NOT NULL,
	`liked` integer DEFAULT 0 NOT NULL,
	`credit` real DEFAULT 0 NOT NULL,
	`credit_at` integer NOT NULL,
	`revision` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rater_status_check" CHECK("rater"."status" IN ('pending', 'trusted', 'flagging', 'flagged'))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `idx_rater_flagging` ON `rater` (`user_id`) WHERE "rater"."status" = 'flagging';--> statement-breakpoint
ALTER TABLE `served` ADD `dealt_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `swipe` ADD `dealt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `swipe` ADD `tally` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Everything already in word_stats came from the feed and was counted: keep it
-- counted, and keep its raters trusted so later lefts and un-likes still apply.
UPDATE `swipe` SET `dealt` = 1, `tally` = 1;--> statement-breakpoint
UPDATE `served` SET `dealt_ids` = `card_ids`;--> statement-breakpoint
INSERT INTO `rater` (`user_id`, `status`, `rated`, `liked`, `credit`, `credit_at`, `updated_at`)
SELECT `user_id`, 'trusted', count(*), sum(`verdict` = 1), 0,
  cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer)
FROM `swipe` GROUP BY `user_id`;
