ALTER TABLE `conversations` ADD `last` text NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `judged`;