CREATE TABLE `payment_checkouts` (
	`order_id` text PRIMARY KEY NOT NULL,
	`collector_id` text NOT NULL,
	`currency` text NOT NULL,
	`preference_state` text NOT NULL,
	`preference_started_at` integer,
	`preference_id` text,
	`checkout_url` text,
	`primary_payment_id` text,
	`next_check_at` integer NOT NULL,
	`last_check_result` text,
	`search_offset` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkouts_preference_id_unique` ON `payment_checkouts` (`preference_id`);--> statement-breakpoint
CREATE INDEX `payment_checkouts_due` ON `payment_checkouts` (`next_check_at`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`source` text NOT NULL,
	`order_id` text,
	`payment_id` text,
	`request_id` text,
	`actor_id` text,
	`outcome` text NOT NULL,
	`from_payment` text,
	`to_payment` text,
	`provider_status` text,
	`provider_updated_at` integer,
	`refunded_amount` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_events_order` ON `payment_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payment_events_retry` ON `payment_events` (`mode`,`source`,`outcome`,`updated_at`);--> statement-breakpoint
CREATE TABLE `payment_records` (
	`mode` text NOT NULL,
	`payment_id` text NOT NULL,
	`order_id` text NOT NULL,
	`provider_status` text NOT NULL,
	`provider_detail` text NOT NULL,
	`provider_updated_at` integer NOT NULL,
	`approved_at` integer,
	`amount` integer NOT NULL,
	`refunded_amount` integer NOT NULL,
	`refund_state` text NOT NULL,
	`refund_key` text,
	`refund_id` text,
	`refund_attempted_at` integer,
	PRIMARY KEY(`mode`, `payment_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_records_order` ON `payment_records` (`order_id`);--> statement-breakpoint
CREATE INDEX `payment_records_refunds` ON `payment_records` (`mode`,`refund_state`,`refund_attempted_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `mode` text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_mode_slot_payment` ON `orders` (`mode`,`slot`,`payment`);