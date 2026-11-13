import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const operation = sqliteTable("operation", {
  id: integer().primaryKey(),
  revision: integer().notNull(),
  config: text().notNull(),
});

export const productOverrides = sqliteTable("product_overrides", {
  id: text().primaryKey(),
  changes: text().notNull(),
});

export const orders = sqliteTable("orders", {
  id: text().primaryKey(),
  tracking: text().unique().notNull(),
  request_key: text().unique().notNull(),
  request_hash: text(),
  mode: text().notNull().default("demo"),
  code: text().notNull(),
  customer: text().notNull(),
  slot: integer().notNull(),
  pickup: text().notNull(),
  items: text().notNull(),
  total: integer().notNull(),
  method: text().notNull(),
  payment: text().notNull(),
  stage: text().notNull(),
  campaign: text(),
  created_at: integer().notNull(),
  expires_at: integer(),
  started_at: integer(),
  ready_at: integer(),
  picked_at: integer(),
  events: text().notNull(),
}, (table) => [
  index("orders_slot_payment").on(table.slot, table.payment),
  index("orders_created_at").on(table.created_at),
  index("orders_payment_expiry").on(table.payment, table.expires_at),
  index("orders_mode_slot_payment").on(table.mode, table.slot, table.payment),
]);

export const paymentCheckouts = sqliteTable("payment_checkouts", {
  order_id: text().primaryKey().notNull().references(() => orders.id),
  collector_id: text().notNull(),
  currency: text().notNull(),
  preference_state: text().notNull(),
  preference_started_at: integer(),
  preference_id: text().unique(),
  checkout_url: text(),
  primary_payment_id: text(),
  next_check_at: integer().notNull(),
  last_check_result: text(),
  search_offset: integer().notNull().default(0),
  version: integer().notNull().default(0),
  write_id: text(),
}, (table) => [index("payment_checkouts_due").on(table.next_check_at)]);

export const paymentRecords = sqliteTable("payment_records", {
  mode: text().notNull(),
  payment_id: text().notNull(),
  order_id: text().notNull().references(() => orders.id),
  provider_status: text().notNull(),
  provider_detail: text().notNull(),
  provider_updated_at: integer().notNull(),
  approved_at: integer(),
  amount: integer().notNull(),
  refunded_amount: integer().notNull(),
  refund_state: text().notNull(),
  refund_key: text(),
  refund_id: text(),
  refund_attempted_at: integer(),
}, (table) => [
  primaryKey({ columns: [table.mode, table.payment_id] }),
  index("payment_records_order").on(table.order_id),
  index("payment_records_refunds").on(table.mode, table.refund_state, table.refund_attempted_at),
]);

export const paymentEvents = sqliteTable("payment_events", {
  id: text().primaryKey().notNull(),
  mode: text().notNull(),
  source: text().notNull(),
  order_id: text().references(() => orders.id),
  payment_id: text(),
  request_id: text(),
  actor_id: text(),
  outcome: text().notNull(),
  from_payment: text(),
  to_payment: text(),
  provider_status: text(),
  provider_updated_at: integer(),
  refunded_amount: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("payment_events_order").on(table.order_id, table.created_at),
  index("payment_events_retry").on(table.mode, table.source, table.outcome, table.updated_at),
]);

export const submissions = sqliteTable("submissions", {
  student: text().primaryKey(),
  product: text().notNull(),
  original: text(),
  edited: text(),
});
