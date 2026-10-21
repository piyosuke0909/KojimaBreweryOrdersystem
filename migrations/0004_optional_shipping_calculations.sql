-- Preserve the existing workflow unless the administrator disables a calculation.
-- Historical rows remain NULL because a zero fare alone cannot identify free shipping.
ALTER TABLE orders ADD COLUMN shipping_fee_source TEXT
  CHECK (shipping_fee_source IS NULL OR shipping_fee_source IN ('automatic','fixed','manual','free'));

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('packing_enabled', 'true'),
  ('yamato_sizes_enabled', 'true'),
  ('yamato_rates_enabled', 'true'),
  ('manual_shipping_fee', '');
