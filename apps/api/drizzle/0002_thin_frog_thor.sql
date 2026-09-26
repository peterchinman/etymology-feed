PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_swipe` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`word` text NOT NULL,
	`verdict` integer NOT NULL,
	`bucket` text,
	`shown_at` integer NOT NULL,
	`swiped_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `word`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "swipe_verdict_check" CHECK("__new_swipe"."verdict" IN (1, -1))
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `__new_swipe`("id", "user_id", "word", "verdict", "bucket", "shown_at", "swiped_at", "received_at") SELECT "id", "user_id", "word", "verdict", "bucket", "shown_at", "swiped_at", "received_at" FROM `swipe`;--> statement-breakpoint
DROP TABLE `swipe`;--> statement-breakpoint
ALTER TABLE `__new_swipe` RENAME TO `swipe`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `swipe_id_unique` ON `swipe` (`id`);--> statement-breakpoint
CREATE INDEX `idx_swipe_user_liked` ON `swipe` (`user_id`,`swiped_at`) WHERE "swipe"."verdict" = 1;
