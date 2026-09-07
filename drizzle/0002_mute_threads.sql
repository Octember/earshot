ALTER TABLE `stepped_back` RENAME TO `muted_threads`;--> statement-breakpoint
ALTER TABLE `muted_threads` RENAME COLUMN "venue_id" TO "channel";--> statement-breakpoint
ALTER TABLE `muted_threads` RENAME COLUMN "thread_root_id" TO "thread_ts";--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN "home_venue_id" TO "channel";--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN "home_thread_root_id" TO "thread_ts";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_muted_threads` (
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`why` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`channel`, `thread_ts`)
);
--> statement-breakpoint
INSERT INTO `__new_muted_threads`("channel", "thread_ts", "why", "at") SELECT "channel", "thread_ts", "why", "at" FROM `muted_threads`;--> statement-breakpoint
DROP TABLE `muted_threads`;--> statement-breakpoint
ALTER TABLE `__new_muted_threads` RENAME TO `muted_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;