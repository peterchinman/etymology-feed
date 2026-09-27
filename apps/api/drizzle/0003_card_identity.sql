ALTER TABLE `swipe` RENAME COLUMN `word` TO `card_id`;
--> statement-breakpoint
DROP INDEX `idx_swipe_user_word`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_swipe_user_card` ON `swipe` (`user_id`,`card_id`);
--> statement-breakpoint
ALTER TABLE `served` RENAME COLUMN `words` TO `card_ids`;
--> statement-breakpoint
ALTER TABLE `word_stats` RENAME COLUMN `word` TO `card_id`;
