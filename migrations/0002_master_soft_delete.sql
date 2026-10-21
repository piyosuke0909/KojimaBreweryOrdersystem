-- Deletion removes masters from operational lists without breaking historical foreign keys.
ALTER TABLE companies ADD COLUMN deleted_at TEXT;
ALTER TABLE products ADD COLUMN deleted_at TEXT;
ALTER TABLE shipping_rules ADD COLUMN deleted_at TEXT;
ALTER TABLE delivery_calendar ADD COLUMN deleted_at TEXT;
ALTER TABLE packaging_boxes ADD COLUMN deleted_at TEXT;
ALTER TABLE yamato_sizes ADD COLUMN deleted_at TEXT;
ALTER TABLE yamato_rates ADD COLUMN deleted_at TEXT;
ALTER TABLE shipping_addresses ADD COLUMN deleted_at TEXT;
ALTER TABLE contracts ADD COLUMN deleted_at TEXT;
ALTER TABLE company_product_prices ADD COLUMN deleted_at TEXT;
ALTER TABLE invitations ADD COLUMN deleted_at TEXT;
