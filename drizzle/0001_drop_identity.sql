DROP INDEX `tasks_dispatch`;--> statement-breakpoint
CREATE INDEX `tasks_dispatch` ON `tasks` (`status`,`opened_at`);--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `identity_id`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stepped_back` (
	`venue_id` text NOT NULL,
	`thread_root_id` text NOT NULL,
	`why` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`venue_id`, `thread_root_id`)
);
--> statement-breakpoint
INSERT INTO `__new_stepped_back`("venue_id", "thread_root_id", "why", "at") SELECT "venue_id", "thread_root_id", "why", "at" FROM `stepped_back`;--> statement-breakpoint
DROP TABLE `stepped_back`;--> statement-breakpoint
ALTER TABLE `__new_stepped_back` RENAME TO `stepped_back`;--> statement-breakpoint
PRAGMA foreign_keys=ON;