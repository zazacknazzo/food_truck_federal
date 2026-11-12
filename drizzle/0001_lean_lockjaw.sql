ALTER TABLE `orders` ADD `request_hash` text;--> statement-breakpoint
CREATE INDEX `orders_payment_expiry` ON `orders` (`payment`,`expires_at`);