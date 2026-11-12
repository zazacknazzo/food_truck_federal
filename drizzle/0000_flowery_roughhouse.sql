CREATE TABLE `operation` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`config` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tracking` text NOT NULL,
	`request_key` text NOT NULL,
	`code` text NOT NULL,
	`customer` text NOT NULL,
	`slot` integer NOT NULL,
	`pickup` text NOT NULL,
	`items` text NOT NULL,
	`total` integer NOT NULL,
	`method` text NOT NULL,
	`payment` text NOT NULL,
	`stage` text NOT NULL,
	`campaign` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`started_at` integer,
	`ready_at` integer,
	`picked_at` integer,
	`events` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_tracking_unique` ON `orders` (`tracking`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_request_key_unique` ON `orders` (`request_key`);--> statement-breakpoint
CREATE INDEX `orders_slot_payment` ON `orders` (`slot`,`payment`);--> statement-breakpoint
CREATE INDEX `orders_created_at` ON `orders` (`created_at`);--> statement-breakpoint
CREATE TABLE `product_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`changes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`student` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`original` text,
	`edited` text
);
