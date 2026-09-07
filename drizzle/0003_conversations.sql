CREATE TABLE `conversations` (
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`since` text NOT NULL,
	`direct` integer NOT NULL,
	`judged` integer NOT NULL,
	`wake_why` text,
	PRIMARY KEY(`channel`, `thread_ts`)
);
