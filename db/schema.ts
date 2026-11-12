import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
]);

export const submissions = sqliteTable("submissions", {
  student: text().primaryKey(),
  product: text().notNull(),
  original: text(),
  edited: text(),
});
