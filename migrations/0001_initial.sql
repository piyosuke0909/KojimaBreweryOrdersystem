-- Cloudflare D1 / SQLite. Schema only: demonstration data is deliberately separate.
PRAGMA foreign_keys = ON;

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT admins_check_1 CHECK (role IN ('owner','staff')),
  CONSTRAINT admins_check_2 CHECK (status IN ('active','inactive'))
);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  postal_code TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT companies_check_1 CHECK (status IN ('active','inactive'))
);

CREATE TABLE shipping_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_condition_json TEXT NOT NULL DEFAULT '{}',
  delivery_method TEXT NOT NULL,
  allowed_periods_json TEXT NOT NULL DEFAULT '[]',
  is_free_shipping INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT shipping_rules_check_1 CHECK (delivery_method IN ('own_delivery','yamato')),
  CONSTRAINT shipping_rules_check_2 CHECK (is_free_shipping IN (0,1)),
  CONSTRAINT shipping_rules_check_3 CHECK (status IN ('active','inactive')),
  CONSTRAINT shipping_rules_check_4 CHECK (json_valid(target_condition_json)),
  CONSTRAINT shipping_rules_check_5 CHECK (json_valid(allowed_periods_json))
);

CREATE TABLE shipping_addresses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  phone TEXT NOT NULL,
  contact_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  shipping_rule_id TEXT REFERENCES shipping_rules(id),
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT shipping_addresses_check_1 CHECK (is_default IN (0,1)),
  CONSTRAINT shipping_addresses_check_2 CHECK (status IN ('active','inactive'))
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  token_hash TEXT NOT NULL UNIQUE,
  max_uses INTEGER DEFAULT 5,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT REFERENCES admins(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT,
  CONSTRAINT invitations_check_1 CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT invitations_check_2 CHECK (used_count >= 0),
  CONSTRAINT invitations_check_3 CHECK (max_uses IS NULL OR used_count <= max_uses),
  CONSTRAINT invitations_check_4 CHECK (status IN ('active','revoked','expired'))
);

CREATE TABLE line_users (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  line_user_id TEXT NOT NULL UNIQUE,
  staff_name TEXT NOT NULL,
  line_display_name TEXT,
  invitation_id TEXT REFERENCES invitations(id),
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT line_users_check_1 CHECK (status IN ('active','unlinked'))
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  contract_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  closing_day INTEGER NOT NULL DEFAULT 31,
  payment_terms TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT contracts_check_1 CHECK (closing_day BETWEEN 1 AND 31),
  CONSTRAINT contracts_check_2 CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT contracts_check_3 CHECK (status IN ('active','inactive'))
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  volume_ml INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT '本',
  standard_price INTEGER,
  tax_type TEXT NOT NULL DEFAULT 'excl',
  weight_kg REAL NOT NULL,
  image_url TEXT,
  short_description TEXT,
  description TEXT,
  commitment TEXT,
  taste TEXT,
  recommended_way TEXT,
  is_limited INTEGER NOT NULL DEFAULT 0,
  sales_status TEXT NOT NULL DEFAULT 'on_sale',
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  CONSTRAINT products_check_1 CHECK (volume_ml > 0),
  CONSTRAINT products_check_2 CHECK (standard_price IS NULL OR standard_price >= 0),
  CONSTRAINT products_check_3 CHECK (tax_type = 'excl'),
  CONSTRAINT products_check_4 CHECK (weight_kg > 0),
  CONSTRAINT products_check_5 CHECK (is_limited IN (0,1)),
  CONSTRAINT products_check_6 CHECK (sales_status IN ('on_sale','suspended','unavailable'))
);

CREATE TABLE company_product_prices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  unit_price INTEGER NOT NULL,
  tax_type TEXT NOT NULL DEFAULT 'excl',
  is_available INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT company_product_prices_check_1 CHECK (unit_price >= 0),
  CONSTRAINT company_product_prices_check_2 CHECK (tax_type = 'excl'),
  CONSTRAINT company_product_prices_check_3 CHECK (is_available IN (0,1)),
  CONSTRAINT company_product_prices_check_4 CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT company_product_prices_check_5 CHECK (status IN ('active','archived'))
);

CREATE TABLE delivery_calendar (
  date TEXT PRIMARY KEY,
  is_deliverable INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  note TEXT,
  CONSTRAINT delivery_calendar_check_1 CHECK (is_deliverable IN (0,1))
);

CREATE TABLE packaging_boxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  supported_volumes_json TEXT NOT NULL,
  max_bottles INTEGER NOT NULL,
  length_cm REAL NOT NULL,
  width_cm REAL NOT NULL,
  height_cm REAL NOT NULL,
  box_weight_kg REAL NOT NULL,
  target_condition TEXT,
  allow_mixed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT packaging_boxes_check_1 CHECK (json_valid(supported_volumes_json)),
  CONSTRAINT packaging_boxes_check_2 CHECK (max_bottles > 0),
  CONSTRAINT packaging_boxes_check_3 CHECK (length_cm > 0 AND width_cm > 0 AND height_cm > 0),
  CONSTRAINT packaging_boxes_check_4 CHECK (box_weight_kg >= 0),
  CONSTRAINT packaging_boxes_check_5 CHECK (allow_mixed IN (0,1)),
  CONSTRAINT packaging_boxes_check_6 CHECK (status IN ('active','inactive')),
  CONSTRAINT packaging_boxes_check_7 CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE yamato_sizes (
  size_code TEXT PRIMARY KEY,
  max_three_sides_cm REAL NOT NULL,
  max_weight_kg REAL NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT yamato_sizes_check_1 CHECK (max_three_sides_cm > 0),
  CONSTRAINT yamato_sizes_check_2 CHECK (max_weight_kg > 0),
  CONSTRAINT yamato_sizes_check_3 CHECK (status IN ('active','inactive')),
  CONSTRAINT yamato_sizes_check_4 CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE yamato_rates (
  id TEXT PRIMARY KEY,
  origin_region TEXT NOT NULL DEFAULT '中部',
  dest_region TEXT NOT NULL,
  size_code TEXT NOT NULL REFERENCES yamato_sizes(size_code),
  shipping_fee INTEGER NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'standard',
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  CONSTRAINT yamato_rates_check_1 CHECK (shipping_fee >= 0),
  CONSTRAINT yamato_rates_check_2 CHECK (rate_type IN ('standard','contract')),
  CONSTRAINT yamato_rates_check_3 CHECK (status IN ('active','inactive')),
  CONSTRAINT yamato_rates_check_4 CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  contract_id TEXT REFERENCES contracts(id),
  ordered_by_line_user_id TEXT,
  ordered_by_name TEXT,
  ordered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  desired_delivery_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  shipping_address_id TEXT REFERENCES shipping_addresses(id),
  snap_recipient_name TEXT NOT NULL,
  snap_postal_code TEXT NOT NULL,
  snap_address TEXT NOT NULL,
  snap_phone TEXT,
  snap_shipping_method TEXT,
  snap_carrier_name TEXT,
  items_subtotal INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL,
  is_shipping_fee_manual INTEGER NOT NULL DEFAULT 0,
  snap_tax_rate INTEGER NOT NULL,
  snap_tax_calc_unit TEXT NOT NULL,
  snap_tax_rounding TEXT NOT NULL,
  tax_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  cancelled_at TEXT,
  edit_lock_status TEXT NOT NULL DEFAULT 'unlocked',
  edit_locked_by TEXT,
  edit_locked_at TEXT,
  edit_lock_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  is_invoice_locked INTEGER NOT NULL DEFAULT 0,
  delivery_note_issued_at TEXT,
  note TEXT,
  CONSTRAINT orders_check_1 CHECK (status IN ('received','confirmed','preparing','shipped','completed','cancelled')),
  CONSTRAINT orders_check_2 CHECK (items_subtotal >= 0 AND shipping_fee >= 0 AND tax_amount >= 0 AND total_amount >= 0),
  CONSTRAINT orders_check_3 CHECK (total_amount = items_subtotal + shipping_fee + tax_amount),
  CONSTRAINT orders_check_4 CHECK (is_shipping_fee_manual IN (0,1)),
  CONSTRAINT orders_check_5 CHECK (snap_tax_rate BETWEEN 0 AND 100),
  CONSTRAINT orders_check_6 CHECK (snap_tax_calc_unit IN ('invoice','order','item')),
  CONSTRAINT orders_check_7 CHECK (snap_tax_rounding IN ('floor','ceil','round')),
  CONSTRAINT orders_check_8 CHECK (edit_lock_status IN ('unlocked','locked')),
  CONSTRAINT orders_check_9 CHECK (version > 0),
  CONSTRAINT orders_check_10 CHECK (is_invoice_locked IN (0,1))
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  snap_product_name TEXT NOT NULL,
  snap_category TEXT,
  snap_volume_ml INTEGER NOT NULL,
  snap_unit TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  subtotal INTEGER NOT NULL,
  CONSTRAINT order_items_check_1 CHECK (line_no > 0),
  CONSTRAINT order_items_check_2 CHECK (snap_volume_ml > 0),
  CONSTRAINT order_items_check_3 CHECK (unit_price >= 0),
  CONSTRAINT order_items_check_4 CHECK (quantity > 0),
  CONSTRAINT order_items_check_5 CHECK (subtotal = unit_price * quantity)
);

CREATE TABLE order_packages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  package_no INTEGER NOT NULL,
  packaging_box_id TEXT REFERENCES packaging_boxes(id),
  size_code TEXT REFERENCES yamato_sizes(size_code),
  three_sides_cm REAL,
  total_weight_kg REAL,
  shipping_fee INTEGER,
  rate_type TEXT,
  note TEXT,
  CONSTRAINT order_packages_check_1 CHECK (package_no > 0),
  CONSTRAINT order_packages_check_2 CHECK (three_sides_cm IS NULL OR three_sides_cm > 0),
  CONSTRAINT order_packages_check_3 CHECK (total_weight_kg IS NULL OR total_weight_kg >= 0),
  CONSTRAINT order_packages_check_4 CHECK (shipping_fee IS NULL OR shipping_fee >= 0),
  CONSTRAINT order_packages_check_5 CHECK (rate_type IS NULL OR rate_type IN ('standard','contract'))
);

CREATE TABLE order_package_items (
  id TEXT PRIMARY KEY,
  order_package_id TEXT NOT NULL REFERENCES order_packages(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_no INTEGER,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  CONSTRAINT order_package_items_check_1 CHECK (quantity > 0)
);

CREATE TABLE order_revisions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision_no INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  changer_type TEXT NOT NULL,
  changer_id TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  before_total INTEGER NOT NULL,
  after_total INTEGER NOT NULL,
  note TEXT,
  CONSTRAINT order_revisions_check_1 CHECK (revision_no > 0),
  CONSTRAINT order_revisions_check_2 CHECK (changer_type IN ('customer','admin')),
  CONSTRAINT order_revisions_check_3 CHECK (json_valid(before_json)),
  CONSTRAINT order_revisions_check_4 CHECK (json_valid(after_json)),
  CONSTRAINT order_revisions_check_5 CHECK (before_total >= 0 AND after_total >= 0)
);

CREATE TABLE order_requests (
  request_id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id),
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  order_id TEXT REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT order_requests_check_1 CHECK (status IN ('pending','completed')),
  CONSTRAINT order_requests_check_2 CHECK ((status = 'pending' AND order_id IS NULL) OR (status = 'completed' AND order_id IS NOT NULL))
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  contract_id TEXT REFERENCES contracts(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  subtotal_excl_tax INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  total_incl_tax INTEGER NOT NULL,
  issued_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'issued',
  latest_version INTEGER NOT NULL DEFAULT 1,
  snap_company_info_json TEXT,
  note TEXT,
  CONSTRAINT invoices_check_1 CHECK (period_end >= period_start),
  CONSTRAINT invoices_check_2 CHECK (subtotal_excl_tax >= 0 AND tax_amount >= 0),
  CONSTRAINT invoices_check_3 CHECK (total_incl_tax = subtotal_excl_tax + tax_amount),
  CONSTRAINT invoices_check_4 CHECK (status IN ('issued','paid','cancelled')),
  CONSTRAINT invoices_check_5 CHECK (latest_version > 0),
  CONSTRAINT invoices_check_6 CHECK (snap_company_info_json IS NULL OR json_valid(snap_company_info_json))
);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  line_no INTEGER NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_date TEXT,
  delivery_date TEXT,
  amount_excl_tax INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  amount_incl_tax INTEGER NOT NULL,
  CONSTRAINT invoice_items_check_1 CHECK (line_no > 0),
  CONSTRAINT invoice_items_check_2 CHECK (amount_excl_tax >= 0 AND tax_amount >= 0),
  CONSTRAINT invoice_items_check_3 CHECK (amount_incl_tax = amount_excl_tax + tax_amount)
);

CREATE TABLE invoice_histories (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  version INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  acted_at TEXT NOT NULL,
  acted_by TEXT REFERENCES admins(id),
  snapshot_json TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES admins(id),
  cancel_reason TEXT,
  note TEXT,
  CONSTRAINT invoice_histories_check_1 CHECK (version > 0),
  CONSTRAINT invoice_histories_check_2 CHECK (action_type IN ('issue','cancel','reissue')),
  CONSTRAINT invoice_histories_check_3 CHECK (json_valid(snapshot_json))
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  acted_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  company_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  note TEXT,
  CONSTRAINT audit_logs_check_1 CHECK (actor_type IN ('admin','customer','system')),
  CONSTRAINT audit_logs_check_2 CHECK (before_json IS NULL OR json_valid(before_json)),
  CONSTRAINT audit_logs_check_3 CHECK (after_json IS NULL OR json_valid(after_json))
);

CREATE TABLE company_info (
  id INTEGER PRIMARY KEY,
  company_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  postal_code TEXT,
  address TEXT,
  tel TEXT,
  fax TEXT,
  email TEXT,
  contact_person TEXT,
  invoice_reg_no TEXT,
  bank_name TEXT,
  bank_branch_name TEXT,
  bank_account_type TEXT,
  bank_account_number TEXT,
  bank_account_holder TEXT,
  note TEXT,
  CONSTRAINT company_info_check_1 CHECK (id = 1),
  CONSTRAINT company_info_check_2 CHECK (bank_account_type IS NULL OR bank_account_type IN ('普通','当座')),
  CONSTRAINT company_info_check_3 CHECK (bank_account_number IS NULL OR (length(bank_account_number) = 7 AND bank_account_number NOT GLOB '*[^0-9]*')),
  CONSTRAINT company_info_check_4 CHECK (invoice_reg_no IS NULL OR (length(invoice_reg_no) = 14 AND substr(invoice_reg_no,1,1) = 'T' AND substr(invoice_reg_no,2) NOT GLOB '*[^0-9]*'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE report_settings (
  id INTEGER PRIMARY KEY,
  delivery_note_title TEXT NOT NULL DEFAULT '納品書',
  invoice_title TEXT NOT NULL DEFAULT '御請求書',
  numbering_rule TEXT NOT NULL DEFAULT 'OYYYYMMDDNNNN,INVYYYYMMNNN',
  show_issuer_info INTEGER NOT NULL DEFAULT 1,
  show_invoice_reg_no INTEGER NOT NULL DEFAULT 1,
  show_contact_person INTEGER NOT NULL DEFAULT 1,
  show_fax INTEGER NOT NULL DEFAULT 1,
  show_email INTEGER NOT NULL DEFAULT 1,
  delivery_note_template TEXT,
  invoice_note_template TEXT,
  CONSTRAINT report_settings_check_1 CHECK (id = 1),
  CONSTRAINT report_settings_check_2 CHECK (show_issuer_info IN (0,1)),
  CONSTRAINT report_settings_check_3 CHECK (show_invoice_reg_no IN (0,1)),
  CONSTRAINT report_settings_check_4 CHECK (show_contact_person IN (0,1)),
  CONSTRAINT report_settings_check_5 CHECK (show_fax IN (0,1)),
  CONSTRAINT report_settings_check_6 CHECK (show_email IN (0,1))
);

CREATE INDEX companies_status_name_idx ON companies (status, name);
CREATE INDEX shipping_addresses_company_id_status_idx ON shipping_addresses (company_id, status);
CREATE INDEX invitations_company_id_status_idx ON invitations (company_id, status);
CREATE INDEX line_users_company_id_status_idx ON line_users (company_id, status);
CREATE INDEX contracts_company_id_status_idx ON contracts (company_id, status);
CREATE INDEX products_sales_status_sort_order_idx ON products (sales_status, sort_order);
CREATE INDEX company_product_prices_company_id_product_id_valid_from_idx ON company_product_prices (company_id, product_id, valid_from);
CREATE INDEX company_product_prices_company_id_product_id_status_valid_from_valid_to_idx ON company_product_prices (company_id, product_id, status, valid_from, valid_to);
CREATE INDEX delivery_calendar_is_deliverable_date_idx ON delivery_calendar (is_deliverable, date);
CREATE INDEX yamato_rates_dest_region_size_code_status_idx ON yamato_rates (dest_region, size_code, status);
CREATE UNIQUE INDEX yamato_rates_origin_region_dest_region_size_code_rate_type_valid_from_uniq ON yamato_rates (origin_region, dest_region, size_code, rate_type, valid_from);
CREATE INDEX orders_company_id_ordered_at_idx ON orders (company_id, ordered_at);
CREATE INDEX orders_status_desired_delivery_date_idx ON orders (status, desired_delivery_date);
CREATE INDEX orders_desired_delivery_date_idx ON orders (desired_delivery_date);
CREATE INDEX orders_is_invoice_locked_status_ordered_at_idx ON orders (is_invoice_locked, status, ordered_at);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);
CREATE UNIQUE INDEX order_items_order_id_line_no_uniq ON order_items (order_id, line_no);
CREATE UNIQUE INDEX order_items_order_id_product_id_uniq ON order_items (order_id, product_id);
CREATE UNIQUE INDEX order_packages_order_id_package_no_uniq ON order_packages (order_id, package_no);
CREATE INDEX order_package_items_order_package_id_idx ON order_package_items (order_package_id);
CREATE INDEX order_package_items_order_id_idx ON order_package_items (order_id);
CREATE UNIQUE INDEX order_revisions_order_id_revision_no_uniq ON order_revisions (order_id, revision_no);
CREATE INDEX order_requests_company_id_issued_at_idx ON order_requests (company_id, issued_at);
CREATE INDEX invoices_company_id_period_start_period_end_idx ON invoices (company_id, period_start, period_end);
CREATE INDEX invoices_status_due_date_idx ON invoices (status, due_date);
CREATE INDEX invoice_items_order_id_idx ON invoice_items (order_id);
CREATE UNIQUE INDEX invoice_items_invoice_id_line_no_uniq ON invoice_items (invoice_id, line_no);
CREATE UNIQUE INDEX invoice_items_invoice_id_order_id_uniq ON invoice_items (invoice_id, order_id);
CREATE UNIQUE INDEX invoice_histories_invoice_id_version_action_type_uniq ON invoice_histories (invoice_id, version, action_type);
CREATE INDEX audit_logs_acted_at_idx ON audit_logs (acted_at);
CREATE INDEX audit_logs_company_id_acted_at_idx ON audit_logs (company_id, acted_at);
CREATE INDEX audit_logs_target_type_target_id_idx ON audit_logs (target_type, target_id);
CREATE UNIQUE INDEX shipping_addresses_default_uniq ON shipping_addresses(company_id) WHERE is_default = 1 AND status = 'active';
