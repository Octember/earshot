ALTER TABLE `conversations` ADD `last` text NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `woken` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `judged`;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `wake_why`;