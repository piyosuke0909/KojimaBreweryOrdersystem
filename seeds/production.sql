-- PRODUCTION INITIAL MASTER DATA. Repeatable; existing records are never overwritten.
-- Product weights are NOT provided by the specifications. Products start unavailable.
-- Replace the explicit 0.001kg sentinel with measured weights and set sales status before accepting orders.
-- Shipping rules, real box measurements, business calendar and fares must be entered by the owner.
-- Contains no fake customers, orders, phone numbers, bank data or credentials.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('price_tax_type', 'excl'),
  ('tax_rate', '10'),
  ('tax_calc_unit', 'invoice'),
  ('tax_rounding', 'floor'),
  ('shipping_taxable', 'true'),
  ('cancel_business_days', '3'),
  ('cancel_cutoff_time', '17:00'),
  ('min_lead_business_days', '4'),
  ('notification_email', ''),
  ('contact_phone', ''),
  ('contact_email', ''),
  ('contact_hours', ''),
  ('invite_valid_days', '30'),
  ('invite_default_max_uses', '5'),
  ('edit_lock_minutes', '10'),
  ('multi_parcel_discount_enabled', 'false'),
  ('multi_parcel_discount_amount', '0');

INSERT OR IGNORE INTO company_info (id, company_name, display_name, note) VALUES
  (1, '小島醸造', '小島醸造', '本番利用前に正式な住所・連絡先・銀行口座・適格請求書登録番号を登録してください。');

INSERT OR IGNORE INTO report_settings (id) VALUES
  (1);

INSERT OR IGNORE INTO products (id, name, category, volume_ml, standard_price, weight_kg, sales_status, sort_order, note) VALUES
  ('samurai-300', '犬山忍冬酒：侍の酒', '新酒・ガラス瓶', 300, 2500, 0.001, 'unavailable', 1, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('samurai-500', '犬山忍冬酒：侍の酒', '新酒・ガラス瓶', 500, 4000, 0.001, 'unavailable', 2, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('samurai-700', '犬山忍冬酒：侍の酒', '新酒・ガラス瓶', 700, 5500, 0.001, 'unavailable', 3, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('kunoichi-300', '忍冬梅酒：くノ一の酒', '新酒・ガラス瓶', 300, 2900, 0.001, 'unavailable', 4, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('kunoichi-500', '忍冬梅酒：くノ一の酒', '新酒・ガラス瓶', 500, 4500, 0.001, 'unavailable', 5, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('kunoichi-700', '忍冬梅酒：くノ一の酒', '新酒・ガラス瓶', 700, 6200, 0.001, 'unavailable', 6, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('shogun-500', '犬山忍冬酒：将軍の酒', '熟成酒・ガラス瓶', 500, 6800, 0.001, 'unavailable', 7, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('umehime-500', '忍冬梅酒：梅姫の酒', '熟成酒・ガラス瓶', 500, 6800, 0.001, 'unavailable', 8, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('nindou-1800', '犬山忍冬酒', '新酒・一升瓶', 1800, 8800, 0.001, 'unavailable', 9, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('umeshu-1800', '忍冬梅酒', '新酒・一升瓶', 1800, 9800, 0.001, 'unavailable', 10, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。'),
  ('mini-80', 'ミニボトル各種', '80ml瓶', 80, NULL, 0.001, 'unavailable', 11, '重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。 ミニボトルは価格も未設定です。');
