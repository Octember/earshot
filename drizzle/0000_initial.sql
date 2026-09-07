CREATE TABLE `stepped_back` (
	`identity_id` text NOT NULL,
	`venue_id` text NOT NULL,
	`thread_root_id` text NOT NULL,
	`why` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`identity_id`, `venue_id`, `thread_root_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`title` text NOT NULL,
	`spec` text NOT NULL,
	`status` text NOT NULL,
	`waiting_on` text,
	`waiting_why` text,
	`wake_at` text,
	`outcome` text,
	`report` text,
	`seen_at` text,
	`home_venue_id` text NOT NULL,
	`home_thread_root_id` text,
	`tier` text DEFAULT 'high' NOT NULL,
	`interruptions` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`opened_at` text NOT NULL,
	CONSTRAINT "tasks_waiting_on" CHECK(("tasks"."status" = 'waiting') = ("tasks"."waiting_on" IS NOT NULL)),
	CONSTRAINT "tasks_wake_at" CHECK("tasks"."wake_at" IS NULL OR "tasks"."status" = 'waiting'),
	CONSTRAINT "tasks_waiting_why" CHECK("tasks"."waiting_on" IS NOT 'human' OR ("tasks"."waiting_why" IS NOT NULL AND trim("tasks"."waiting_why") <> '')),
	CONSTRAINT "tasks_outcome" CHECK(("tasks"."status" = 'done') = ("tasks"."outcome" IS NOT NULL)),
	CONSTRAINT "tasks_report" CHECK("tasks"."status" <> 'done' OR ("tasks"."report" IS NOT NULL AND trim("tasks"."report") <> ''))
);
--> statement-breakpoint
CREATE INDEX `tasks_dispatch` ON `tasks` (`identity_id`,`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `tasks_due` ON `tasks` (`status`,`wake_at`);