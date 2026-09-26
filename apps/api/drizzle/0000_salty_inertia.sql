CREATE TABLE `served` (
	`user_id` text PRIMARY KEY NOT NULL,
	`words` text NOT NULL,
	`count` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
 ) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `swipe` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`word` text NOT NULL,
	`verdict` integer NOT NULL,
	`bucket` text,
	`shown_at` integer NOT NULL,
	`swiped_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "swipe_verdict_check" CHECK("swipe"."verdict" IN (1, -1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_swipe_user_word` ON `swipe` (`user_id`,`word`);--> statement-breakpoint
CREATE INDEX `idx_swipe_user_liked` ON `swipe` (`user_id`,`swiped_at`) WHERE "swipe"."verdict" = 1;--> statement-breakpoint
CREATE INDEX `idx_swipe_word` ON `swipe` (`word`);--> statement-breakpoint
CREATE TABLE `word_stats` (
	`word` text PRIMARY KEY NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`dislikes` integer DEFAULT 0 NOT NULL,
	`prior` real NOT NULL,
	`score` real NOT NULL,
	`updated_at` integer NOT NULL
 ) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `idx_word_stats_score` ON `word_stats` (`score`);--> statement-breakpoint
CREATE INDEX `idx_word_stats_unrated` ON `word_stats` (("likes" + "dislikes"),`prior`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`is_anonymous` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
