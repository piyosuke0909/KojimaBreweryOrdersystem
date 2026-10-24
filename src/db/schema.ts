import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex, check, primaryKey } from 'drizzle-orm/sqlite-core';

// SQL names and TypeScript properties intentionally match API payloads and D1 rows.
export const admins = sqliteTable('admins', {
  id: text('id').primaryKey(),
  login_id: text('login_id').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default('staff'),
  session_version: integer('session_version').notNull().default(0),
  status: text('status').notNull().default('active'),
  created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  check('admins_check_1', sql`role IN ('owner','staff')`),
  check('admins_check_2', sql`status IN ('active','inactive')`),
  check('admins_session_version', sql`${t.session_version}>=0`),
]);

export const companies = sqliteTable('companies', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  contact_name: text('contact_name'),
  phone: text('phone'),
  postal_code: text('postal_code'),
  address: text('address'),
  status: text('status').notNull().default('active'),
  note: text('note'),
  created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  check('companies_check_1', sql`status IN ('active','inactive')`),
  index('companies_status_name_idx').on(t.status, t.name),
]);

export const shipping_rules = sqliteTable('shipping_rules', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  target_condition_json: text('target_condition_json').notNull().default('{}'),
  delivery_method: text('delivery_method').notNull(),
  allowed_periods_json: text('allowed_periods_json').notNull().default('[]'),
  is_free_shipping: integer('is_free_shipping').notNull().default(0),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('shipping_rules_check_1', sql`delivery_method IN ('own_delivery','yamato')`),
  check('shipping_rules_check_2', sql`is_free_shipping IN (0,1)`),
  check('shipping_rules_check_3', sql`status IN ('active','inactive')`),
  check('shipping_rules_check_4', sql`json_valid(target_condition_json)`),
  check('shipping_rules_check_5', sql`json_valid(allowed_periods_json)`),
]);

export const shipping_addresses = sqliteTable('shipping_addresses', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  postal_code: text('postal_code').notNull(),
  prefecture: text('prefecture').notNull(),
  city: text('city').notNull(),
  address_line1: text('address_line1').notNull(),
  address_line2: text('address_line2'),
  phone: text('phone').notNull(),
  contact_name: text('contact_name'),
  is_default: integer('is_default').notNull().default(0),
  shipping_rule_id: text('shipping_rule_id').references(() => shipping_rules.id),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('shipping_addresses_check_1', sql`is_default IN (0,1)`),
  check('shipping_addresses_check_2', sql`status IN ('active','inactive')`),
  index('shipping_addresses_company_id_status_idx').on(t.company_id, t.status),
  uniqueIndex('shipping_addresses_default_uniq').on(t.company_id).where(sql`is_default = 1 AND status = 'active'`),
]);

export const invitations = sqliteTable('invitations', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  token_hash: text('token_hash').notNull().unique(),
  token_ciphertext: text('token_ciphertext'),
  max_uses: integer('max_uses').default(5),
  used_count: integer('used_count').notNull().default(0),
  expires_at: text('expires_at').notNull(), // Empty string means no expiry; APIs return null.
  status: text('status').notNull().default('active'),
  created_by: text('created_by').references(() => admins.id),
  created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  note: text('note'),
}, (t) => [
  check('invitations_check_1', sql`max_uses IS NULL OR max_uses > 0`),
  check('invitations_check_2', sql`used_count >= 0`),
  check('invitations_check_3', sql`max_uses IS NULL OR used_count <= max_uses`),
  check('invitations_check_4', sql`status IN ('active','revoked','expired')`),
  index('invitations_company_id_status_idx').on(t.company_id, t.status),
]);

export const line_invitation_handoffs = sqliteTable('line_invitation_handoffs', {
  subject_hash: text('subject_hash').primaryKey(),
  handoff_id: text('handoff_id').notNull().unique(),
  invitation_id: text('invitation_id').notNull().references(() => invitations.id),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
}, (t) => [
  check('line_invitation_handoffs_subject_hash_check', sql`length(subject_hash) = 64`),
  check('line_invitation_handoffs_expiry_check', sql`expires_at > created_at`),
  index('line_invitation_handoffs_expires_idx').on(t.expires_at),
]);

export const line_users = sqliteTable('line_users', {
  session_version: integer('session_version').notNull().default(0),
  registration_handoff_hash: text('registration_handoff_hash'),
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  line_user_id: text('line_user_id').notNull().unique(),
  staff_name: text('staff_name').notNull(),
  line_display_name: text('line_display_name'),
  invitation_id: text('invitation_id').references(() => invitations.id),
  registered_at: text('registered_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('line_users_check_1', sql`status IN ('active','unlinked')`),
  check('line_users_session_version', sql`session_version >= 0`),
  check('line_users_registration_handoff_hash', sql`registration_handoff_hash IS NULL OR length(registration_handoff_hash) = 64`),
  index('line_users_company_id_status_idx').on(t.company_id, t.status),
]);

export const contracts = sqliteTable('contracts', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  contract_name: text('contract_name').notNull(),
  start_date: text('start_date').notNull(),
  end_date: text('end_date'),
  closing_day: integer('closing_day').notNull().default(31),
  payment_terms: text('payment_terms'),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('contracts_check_1', sql`closing_day BETWEEN 1 AND 31`),
  check('contracts_check_2', sql`end_date IS NULL OR end_date >= start_date`),
  check('contracts_check_3', sql`status IN ('active','inactive')`),
  index('contracts_company_id_status_idx').on(t.company_id, t.status),
]);

export const products = sqliteTable('products', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  volume_ml: integer('volume_ml').notNull(),
  unit: text('unit').notNull().default('本'),
  standard_price: integer('standard_price'),
  tax_type: text('tax_type').notNull().default('excl'),
  weight_kg: real('weight_kg').notNull(),
  image_url: text('image_url'),
  short_description: text('short_description'),
  description: text('description'),
  commitment: text('commitment'),
  taste: text('taste'),
  recommended_way: text('recommended_way'),
  is_limited: integer('is_limited').notNull().default(0),
  sales_status: text('sales_status').notNull().default('on_sale'),
  sort_order: integer('sort_order').notNull().default(0),
  note: text('note'),
}, (t) => [
  check('products_check_1', sql`volume_ml > 0`),
  check('products_check_2', sql`standard_price IS NULL OR standard_price >= 0`),
  check('products_check_3', sql`tax_type = 'excl'`),
  check('products_check_4', sql`weight_kg > 0`),
  check('products_check_5', sql`is_limited IN (0,1)`),
  check('products_check_6', sql`sales_status IN ('on_sale','suspended','unavailable')`),
  index('products_sales_status_sort_order_idx').on(t.sales_status, t.sort_order),
]);

export const company_product_prices = sqliteTable('company_product_prices', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  product_id: text('product_id').notNull().references(() => products.id),
  unit_price: integer('unit_price').notNull(),
  tax_type: text('tax_type').notNull().default('excl'),
  is_available: integer('is_available').notNull().default(1),
  valid_from: text('valid_from').notNull(),
  valid_to: text('valid_to'),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('company_product_prices_check_1', sql`unit_price >= 0`),
  check('company_product_prices_check_2', sql`tax_type = 'excl'`),
  check('company_product_prices_check_3', sql`is_available IN (0,1)`),
  check('company_product_prices_check_4', sql`valid_to IS NULL OR valid_to >= valid_from`),
  check('company_product_prices_check_5', sql`status IN ('active','archived')`),
  index('company_product_prices_company_id_product_id_valid_from_idx').on(t.company_id, t.product_id, t.valid_from),
  index('company_product_prices_company_id_product_id_status_valid_from_valid_to_idx').on(t.company_id, t.product_id, t.status, t.valid_from, t.valid_to),
]);

export const delivery_calendar = sqliteTable('delivery_calendar', {
  deleted_at: text('deleted_at'),
  date: text('date').primaryKey(),
  is_deliverable: integer('is_deliverable').notNull().default(1),
  reason: text('reason'),
  note: text('note'),
}, (t) => [
  check('delivery_calendar_check_1', sql`is_deliverable IN (0,1)`),
  index('delivery_calendar_is_deliverable_date_idx').on(t.is_deliverable, t.date),
]);

export const packaging_boxes = sqliteTable('packaging_boxes', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  supported_volumes_json: text('supported_volumes_json').notNull(),
  max_bottles: integer('max_bottles').notNull(),
  length_cm: real('length_cm').notNull(),
  width_cm: real('width_cm').notNull(),
  height_cm: real('height_cm').notNull(),
  box_weight_kg: real('box_weight_kg').notNull(),
  target_condition: text('target_condition'),
  allow_mixed: integer('allow_mixed').notNull().default(0),
  priority: integer('priority').notNull().default(0),
  valid_from: text('valid_from'),
  valid_to: text('valid_to'),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('packaging_boxes_check_1', sql`json_valid(supported_volumes_json)`),
  check('packaging_boxes_check_2', sql`max_bottles > 0`),
  check('packaging_boxes_check_3', sql`length_cm > 0 AND width_cm > 0 AND height_cm > 0`),
  check('packaging_boxes_check_4', sql`box_weight_kg >= 0`),
  check('packaging_boxes_check_5', sql`allow_mixed IN (0,1)`),
  check('packaging_boxes_check_6', sql`status IN ('active','inactive')`),
  check('packaging_boxes_check_7', sql`valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from`),
]);

export const yamato_sizes = sqliteTable('yamato_sizes', {
  deleted_at: text('deleted_at'),
  size_code: text('size_code').primaryKey(),
  max_three_sides_cm: real('max_three_sides_cm').notNull(),
  max_weight_kg: real('max_weight_kg').notNull(),
  valid_from: text('valid_from'),
  valid_to: text('valid_to'),
  status: text('status').notNull().default('active'),
}, (t) => [
  check('yamato_sizes_check_1', sql`max_three_sides_cm > 0`),
  check('yamato_sizes_check_2', sql`max_weight_kg > 0`),
  check('yamato_sizes_check_3', sql`status IN ('active','inactive')`),
  check('yamato_sizes_check_4', sql`valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from`),
]);

export const yamato_rates = sqliteTable('yamato_rates', {
  deleted_at: text('deleted_at'),
  id: text('id').primaryKey(),
  origin_region: text('origin_region').notNull().default('中部'),
  dest_region: text('dest_region').notNull(),
  size_code: text('size_code').notNull().references(() => yamato_sizes.size_code),
  shipping_fee: integer('shipping_fee').notNull(),
  rate_type: text('rate_type').notNull().default('standard'),
  valid_from: text('valid_from'),
  valid_to: text('valid_to'),
  status: text('status').notNull().default('active'),
  note: text('note'),
}, (t) => [
  check('yamato_rates_check_1', sql`shipping_fee >= 0`),
  check('yamato_rates_check_2', sql`rate_type IN ('standard','contract')`),
  check('yamato_rates_check_3', sql`status IN ('active','inactive')`),
  check('yamato_rates_check_4', sql`valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from`),
  index('yamato_rates_dest_region_size_code_status_idx').on(t.dest_region, t.size_code, t.status),
  uniqueIndex('yamato_rates_origin_region_dest_region_size_code_rate_type_valid_from_uniq').on(t.origin_region, t.dest_region, t.size_code, t.rate_type, t.valid_from),
]);

export const orders = sqliteTable('orders', {
  request_hash: text('request_hash'),
  snap_shipping_taxable: integer('snap_shipping_taxable'),
  id: text('id').primaryKey(),
  request_id: text('request_id').notNull().unique(),
  company_id: text('company_id').notNull().references(() => companies.id),
  contract_id: text('contract_id').references(() => contracts.id),
  ordered_by_line_user_id: text('ordered_by_line_user_id'),
  ordered_by_name: text('ordered_by_name'),
  ordered_at: text('ordered_at').notNull(),
  updated_at: text('updated_at').notNull(),
  desired_delivery_date: text('desired_delivery_date').notNull(),
  status: text('status').notNull().default('received'),
  shipping_address_id: text('shipping_address_id').references(() => shipping_addresses.id),
  snap_recipient_name: text('snap_recipient_name').notNull(),
  snap_postal_code: text('snap_postal_code').notNull(),
  snap_address: text('snap_address').notNull(),
  snap_phone: text('snap_phone'),
  snap_shipping_method: text('snap_shipping_method'),
  snap_carrier_name: text('snap_carrier_name'),
  items_subtotal: integer('items_subtotal').notNull(),
  shipping_fee: integer('shipping_fee').notNull(),
  is_shipping_fee_manual: integer('is_shipping_fee_manual').notNull().default(0),
  shipping_fee_source: text('shipping_fee_source'),
  snap_tax_rate: integer('snap_tax_rate').notNull(),
  snap_tax_calc_unit: text('snap_tax_calc_unit').notNull(),
  snap_tax_rounding: text('snap_tax_rounding').notNull(),
  tax_amount: integer('tax_amount').notNull(),
  total_amount: integer('total_amount').notNull(),
  cancelled_at: text('cancelled_at'),
  edit_lock_status: text('edit_lock_status').notNull().default('unlocked'),
  edit_locked_by: text('edit_locked_by'),
  edit_locked_at: text('edit_locked_at'),
  edit_lock_expires_at: text('edit_lock_expires_at'),
  version: integer('version').notNull().default(1),
  is_invoice_locked: integer('is_invoice_locked').notNull().default(0),
  delivery_note_issued_at: text('delivery_note_issued_at'),
  note: text('note'),
}, (t) => [
  check('orders_check_1', sql`status IN ('received','confirmed','preparing','shipped','completed','cancelled')`),
  check('orders_check_2', sql`items_subtotal >= 0 AND shipping_fee >= 0 AND tax_amount >= 0 AND total_amount >= 0`),
  check('orders_check_3', sql`total_amount = items_subtotal + shipping_fee + tax_amount`),
  check('orders_check_4', sql`is_shipping_fee_manual IN (0,1)`),
  check('orders_shipping_fee_source_check', sql`shipping_fee_source IS NULL OR shipping_fee_source IN ('automatic','fixed','manual','free')`),
  check('orders_check_5', sql`snap_tax_rate BETWEEN 0 AND 100`),
  check('orders_check_6', sql`snap_tax_calc_unit IN ('invoice','order','item')`),
  check('orders_check_7', sql`snap_tax_rounding IN ('floor','ceil','round')`),
  check('orders_request_hash', sql`request_hash IS NULL OR length(request_hash) = 64`),
  check('orders_shipping_taxable', sql`snap_shipping_taxable IS NULL OR snap_shipping_taxable IN (0,1)`),
  check('orders_check_8', sql`edit_lock_status IN ('unlocked','locked')`),
  check('orders_check_9', sql`version > 0`),
  check('orders_check_10', sql`is_invoice_locked IN (0,1)`),
  index('orders_company_id_ordered_at_idx').on(t.company_id, t.ordered_at),
  index('orders_status_desired_delivery_date_idx').on(t.status, t.desired_delivery_date),
  index('orders_desired_delivery_date_idx').on(t.desired_delivery_date),
  index('orders_is_invoice_locked_status_ordered_at_idx').on(t.is_invoice_locked, t.status, t.ordered_at),
]);

export const order_items = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  order_id: text('order_id').notNull().references(() => orders.id),
  line_no: integer('line_no').notNull(),
  product_id: text('product_id').notNull().references(() => products.id),
  snap_product_name: text('snap_product_name').notNull(),
  snap_category: text('snap_category'),
  snap_volume_ml: integer('snap_volume_ml').notNull(),
  snap_unit: text('snap_unit').notNull(),
  unit_price: integer('unit_price').notNull(),
  quantity: integer('quantity').notNull(),
  subtotal: integer('subtotal').notNull(),
}, (t) => [
  check('order_items_check_1', sql`line_no > 0`),
  check('order_items_check_2', sql`snap_volume_ml > 0`),
  check('order_items_check_3', sql`unit_price >= 0`),
  check('order_items_check_4', sql`quantity > 0`),
  check('order_items_check_5', sql`subtotal = unit_price * quantity`),
  index('order_items_product_id_idx').on(t.product_id),
  uniqueIndex('order_items_order_id_line_no_uniq').on(t.order_id, t.line_no),
  uniqueIndex('order_items_order_id_product_id_uniq').on(t.order_id, t.product_id),
]);

export const order_packages = sqliteTable('order_packages', {
  id: text('id').primaryKey(),
  order_id: text('order_id').notNull().references(() => orders.id),
  package_no: integer('package_no').notNull(),
  packaging_box_id: text('packaging_box_id').references(() => packaging_boxes.id),
  size_code: text('size_code').references(() => yamato_sizes.size_code),
  three_sides_cm: real('three_sides_cm'),
  total_weight_kg: real('total_weight_kg'),
  shipping_fee: integer('shipping_fee'),
  rate_type: text('rate_type'),
  note: text('note'),
}, (t) => [
  check('order_packages_check_1', sql`package_no > 0`),
  check('order_packages_check_2', sql`three_sides_cm IS NULL OR three_sides_cm > 0`),
  check('order_packages_check_3', sql`total_weight_kg IS NULL OR total_weight_kg >= 0`),
  check('order_packages_check_4', sql`shipping_fee IS NULL OR shipping_fee >= 0`),
  check('order_packages_check_5', sql`rate_type IS NULL OR rate_type IN ('standard','contract')`),
  uniqueIndex('order_packages_order_id_package_no_uniq').on(t.order_id, t.package_no),
]);

export const order_package_items = sqliteTable('order_package_items', {
  id: text('id').primaryKey(),
  order_package_id: text('order_package_id').notNull().references(() => order_packages.id),
  order_id: text('order_id').notNull().references(() => orders.id),
  line_no: integer('line_no'),
  product_id: text('product_id').notNull().references(() => products.id),
  quantity: integer('quantity').notNull(),
}, (t) => [
  check('order_package_items_check_1', sql`quantity > 0`),
  index('order_package_items_order_package_id_idx').on(t.order_package_id),
  index('order_package_items_order_id_idx').on(t.order_id),
]);

export const order_revisions = sqliteTable('order_revisions', {
  id: text('id').primaryKey(),
  order_id: text('order_id').notNull().references(() => orders.id),
  revision_no: integer('revision_no').notNull(),
  changed_at: text('changed_at').notNull(),
  changer_type: text('changer_type').notNull(),
  changer_id: text('changer_id'),
  before_json: text('before_json').notNull(),
  after_json: text('after_json').notNull(),
  before_total: integer('before_total').notNull(),
  after_total: integer('after_total').notNull(),
  note: text('note'),
}, (t) => [
  check('order_revisions_check_1', sql`revision_no > 0`),
  check('order_revisions_check_2', sql`changer_type IN ('customer','admin')`),
  check('order_revisions_check_3', sql`json_valid(before_json)`),
  check('order_revisions_check_4', sql`json_valid(after_json)`),
  check('order_revisions_check_5', sql`before_total >= 0 AND after_total >= 0`),
  uniqueIndex('order_revisions_order_id_revision_no_uniq').on(t.order_id, t.revision_no),
]);

export const order_requests = sqliteTable('order_requests', {
  request_id: text('request_id').primaryKey(),
  line_user_id: text('line_user_id').notNull(),
  company_id: text('company_id').notNull().references(() => companies.id),
  issued_at: text('issued_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  processed_at: text('processed_at'),
  order_id: text('order_id').references(() => orders.id),
  status: text('status').notNull().default('pending'),
}, (t) => [
  check('order_requests_check_1', sql`status IN ('pending','completed')`),
  check('order_requests_check_2', sql`(status = 'pending' AND order_id IS NULL) OR (status = 'completed' AND order_id IS NOT NULL)`),
  index('order_requests_company_id_issued_at_idx').on(t.company_id, t.issued_at),
]);

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  company_id: text('company_id').notNull().references(() => companies.id),
  contract_id: text('contract_id').references(() => contracts.id),
  period_start: text('period_start').notNull(),
  period_end: text('period_end').notNull(),
  subtotal_excl_tax: integer('subtotal_excl_tax').notNull(),
  tax_amount: integer('tax_amount').notNull(),
  total_incl_tax: integer('total_incl_tax').notNull(),
  issued_date: text('issued_date'),
  due_date: text('due_date'),
  status: text('status').notNull().default('issued'),
  latest_version: integer('latest_version').notNull().default(1),
  snap_company_info_json: text('snap_company_info_json'),
  note: text('note'),
}, (t) => [
  check('invoices_check_1', sql`period_end >= period_start`),
  check('invoices_check_2', sql`subtotal_excl_tax >= 0 AND tax_amount >= 0`),
  check('invoices_check_3', sql`total_incl_tax = subtotal_excl_tax + tax_amount`),
  check('invoices_check_4', sql`status IN ('issued','paid','cancelled')`),
  check('invoices_check_5', sql`latest_version > 0`),
  check('invoices_check_6', sql`snap_company_info_json IS NULL OR json_valid(snap_company_info_json)`),
  index('invoices_company_id_period_start_period_end_idx').on(t.company_id, t.period_start, t.period_end),
  index('invoices_status_due_date_idx').on(t.status, t.due_date),
]);

export const invoice_items = sqliteTable('invoice_items', {
  id: text('id').primaryKey(),
  invoice_id: text('invoice_id').notNull().references(() => invoices.id),
  line_no: integer('line_no').notNull(),
  order_id: text('order_id').notNull().references(() => orders.id),
  order_date: text('order_date'),
  delivery_date: text('delivery_date'),
  amount_excl_tax: integer('amount_excl_tax').notNull(),
  tax_amount: integer('tax_amount').notNull(),
  amount_incl_tax: integer('amount_incl_tax').notNull(),
}, (t) => [
  check('invoice_items_check_1', sql`line_no > 0`),
  check('invoice_items_check_2', sql`amount_excl_tax >= 0 AND tax_amount >= 0`),
  check('invoice_items_check_3', sql`amount_incl_tax = amount_excl_tax + tax_amount`),
  index('invoice_items_order_id_idx').on(t.order_id),
  uniqueIndex('invoice_items_invoice_id_line_no_uniq').on(t.invoice_id, t.line_no),
  uniqueIndex('invoice_items_invoice_id_order_id_uniq').on(t.invoice_id, t.order_id),
]);

export const invoice_histories = sqliteTable('invoice_histories', {
  id: text('id').primaryKey(),
  invoice_id: text('invoice_id').notNull().references(() => invoices.id),
  version: integer('version').notNull(),
  action_type: text('action_type').notNull(),
  acted_at: text('acted_at').notNull(),
  acted_by: text('acted_by').references(() => admins.id),
  snapshot_json: text('snapshot_json').notNull(),
  cancelled_at: text('cancelled_at'),
  cancelled_by: text('cancelled_by').references(() => admins.id),
  cancel_reason: text('cancel_reason'),
  note: text('note'),
  request_id: text('request_id'),
  request_hash: text('request_hash'),
}, (t) => [
  check('invoice_histories_check_1', sql`version > 0`),
  check('invoice_histories_check_2', sql`action_type IN ('issue','cancel','reissue')`),
  check('invoice_histories_check_3', sql`json_valid(snapshot_json)`),
  uniqueIndex('invoice_histories_invoice_id_version_action_type_uniq').on(t.invoice_id, t.version, t.action_type),
  uniqueIndex('invoice_histories_request_id_uniq').on(t.request_id).where(sql`${t.request_id} IS NOT NULL`),
]);

export const delivery_note_histories = sqliteTable('delivery_note_histories', {
  id: text('id').primaryKey().notNull(),
  order_id: text('order_id').notNull().references(() => orders.id),
  invoice_id: text('invoice_id').references(() => invoices.id),
  version: integer('version').notNull(),
  request_id: text('request_id').notNull().unique(),
  request_hash: text('request_hash').notNull(),
  snapshot_json: text('snapshot_json').notNull(),
  issued_at: text('issued_at').notNull(),
  issued_by: text('issued_by').notNull().references(() => admins.id),
  source_order_version: integer('source_order_version').notNull(),
  source_invoice_version: integer('source_invoice_version'),
}, (t) => [
  check('delivery_note_histories_version', sql`${t.version}>0`),
  check('delivery_note_histories_snapshot', sql`json_valid(${t.snapshot_json})`),
  check('delivery_note_histories_order_version', sql`${t.source_order_version}>0`),
  check('delivery_note_histories_invoice_version', sql`${t.source_invoice_version} IS NULL OR ${t.source_invoice_version}>0`),
  check('delivery_note_histories_invoice_source', sql`(${t.invoice_id} IS NULL AND ${t.source_invoice_version} IS NULL) OR (${t.invoice_id} IS NOT NULL AND ${t.source_invoice_version} IS NOT NULL)`),
  uniqueIndex('delivery_note_histories_order_version_uniq').on(t.order_id,t.version),
  index('delivery_note_histories_invoice_idx').on(t.invoice_id,sql`${t.issued_at} DESC`),
]);

export const audit_logs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  acted_at: text('acted_at').notNull(),
  actor_type: text('actor_type').notNull(),
  actor_id: text('actor_id'),
  company_id: text('company_id'),
  action: text('action').notNull(),
  target_type: text('target_type').notNull(),
  target_id: text('target_id').notNull(),
  before_json: text('before_json'),
  after_json: text('after_json'),
  note: text('note'),
}, (t) => [
  check('audit_logs_check_1', sql`actor_type IN ('admin','customer','system')`),
  check('audit_logs_check_2', sql`before_json IS NULL OR json_valid(before_json)`),
  check('audit_logs_check_3', sql`after_json IS NULL OR json_valid(after_json)`),
  index('audit_logs_acted_at_idx').on(t.acted_at),
  index('audit_logs_company_id_acted_at_idx').on(t.company_id, t.acted_at),
  index('audit_logs_target_type_target_id_idx').on(t.target_type, t.target_id),
]);

export const company_info = sqliteTable('company_info', {
  id: integer('id').primaryKey(),
  company_name: text('company_name').notNull(),
  display_name: text('display_name').notNull(),
  postal_code: text('postal_code'),
  address: text('address'),
  tel: text('tel'),
  fax: text('fax'),
  email: text('email'),
  contact_person: text('contact_person'),
  invoice_reg_no: text('invoice_reg_no'),
  bank_name: text('bank_name'),
  bank_branch_name: text('bank_branch_name'),
  bank_account_type: text('bank_account_type'),
  bank_account_number: text('bank_account_number'),
  bank_account_holder: text('bank_account_holder'),
  note: text('note'),
}, (t) => [
  check('company_info_check_1', sql`id = 1`),
  check('company_info_check_2', sql`bank_account_type IS NULL OR bank_account_type IN ('普通','当座')`),
  check('company_info_check_3', sql`bank_account_number IS NULL OR (length(bank_account_number) = 7 AND bank_account_number NOT GLOB '*[^0-9]*')`),
  check('company_info_check_4', sql`invoice_reg_no IS NULL OR (length(invoice_reg_no) = 14 AND substr(invoice_reg_no,1,1) = 'T' AND substr(invoice_reg_no,2) NOT GLOB '*[^0-9]*')`),
]);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const report_settings = sqliteTable('report_settings', {
  id: integer('id').primaryKey(),
  delivery_note_title: text('delivery_note_title').notNull().default('納品書'),
  invoice_title: text('invoice_title').notNull().default('御請求書'),
  numbering_rule: text('numbering_rule').notNull().default('OYYYYMMDDNNNN,INVYYYYMMNNN'),
  show_issuer_info: integer('show_issuer_info').notNull().default(1),
  show_invoice_reg_no: integer('show_invoice_reg_no').notNull().default(1),
  show_contact_person: integer('show_contact_person').notNull().default(1),
  show_fax: integer('show_fax').notNull().default(1),
  show_email: integer('show_email').notNull().default(1),
  delivery_note_template: text('delivery_note_template'),
  invoice_note_template: text('invoice_note_template'),
}, (t) => [
  check('report_settings_check_1', sql`id = 1`),
  check('report_settings_check_2', sql`show_issuer_info IN (0,1)`),
  check('report_settings_check_3', sql`show_invoice_reg_no IN (0,1)`),
  check('report_settings_check_4', sql`show_contact_person IN (0,1)`),
  check('report_settings_check_5', sql`show_fax IN (0,1)`),
  check('report_settings_check_6', sql`show_email IN (0,1)`),
]);

export const email_notification_config = sqliteTable('email_notification_config', {
  id: integer('id').primaryKey().notNull(),
  provider: text('provider').notNull().default('gmail'),
  enabled: integer('enabled').notNull().default(0),
  recipients_json: text('recipients_json').notNull().default('[]'),
  sender_email: text('sender_email').notNull().default(''),
  notify_created: integer('notify_created').notNull().default(1),
  notify_edited: integer('notify_edited').notNull().default(0),
  notify_cancelled: integer('notify_cancelled').notNull().default(1),
  gmail_client_id: text('gmail_client_id').notNull().default(''),
  gmail_client_secret_ciphertext: text('gmail_client_secret_ciphertext'),
  gmail_refresh_token_ciphertext: text('gmail_refresh_token_ciphertext'),
  app_origin: text('app_origin').notNull(),
  version: integer('version').notNull().default(1),
  updated_at: text('updated_at').notNull(),
},(t)=>[
  check('email_notification_config_singleton',sql`id = 1`),
  check('email_notification_config_provider',sql`provider IN ('gmail','resend')`),
  check('email_notification_config_enabled',sql`enabled IN (0,1)`),
  check('email_notification_config_recipients',sql`json_valid(recipients_json)`),
  check('email_notification_config_created',sql`notify_created IN (0,1)`),
  check('email_notification_config_edited',sql`notify_edited IN (0,1)`),
  check('email_notification_config_cancelled',sql`notify_cancelled IN (0,1)`),
]);
export const gmail_oauth_states = sqliteTable('gmail_oauth_states', {
  state_hash: text('state_hash').primaryKey().notNull(),
  admin_id: text('admin_id').notNull().references(()=>admins.id),
  code_verifier_ciphertext: text('code_verifier_ciphertext').notNull(),
  client_id: text('client_id').notNull(),
  redirect_uri: text('redirect_uri').notNull(),
  config_version: integer('config_version').notNull(),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
},(t)=>[
  check('gmail_oauth_states_hash',sql`length(state_hash) = 64`),
  check('gmail_oauth_states_lifetime',sql`expires_at > created_at`),
  index('gmail_oauth_states_expires_idx').on(t.expires_at),
]);

export const admin_notifications = sqliteTable('admin_notifications', {
  id: text('id').primaryKey().notNull(),
  event_key: text('event_key').notNull().unique(),
  kind: text('kind').notNull(),
  category: text('category').notNull(),
  company_id: text('company_id').notNull().references(()=>companies.id,{onDelete:'cascade'}),
  order_id: text('order_id').references(()=>orders.id,{onDelete:'cascade'}),
  line_user_id: text('line_user_id').references(()=>line_users.id,{onDelete:'cascade'}),
  title: text('title').notNull(),
  created_at: text('created_at').notNull(),
},(t)=>[
  check('admin_notifications_kind',sql`kind IN ('order_created','order_updated','order_cancelled','line_message')`),
  check('admin_notifications_category',sql`category IN ('orders','companies')`),
  check('admin_notifications_target',sql`(category='orders' AND order_id IS NOT NULL AND kind IN ('order_created','order_updated','order_cancelled')) OR (category='companies' AND line_user_id IS NOT NULL AND kind='line_message')`),
  index('admin_notifications_created_idx').on(sql`${t.created_at} DESC`,sql`${t.id} DESC`),
  index('admin_notifications_thread_idx').on(t.company_id,t.line_user_id,t.kind),
]);
export const admin_notification_reads = sqliteTable('admin_notification_reads', {
  notification_id: text('notification_id').notNull().references(()=>admin_notifications.id,{onDelete:'cascade'}),
  admin_id: text('admin_id').notNull().references(()=>admins.id,{onDelete:'cascade'}),
  read_at: text('read_at').notNull(),
},(t)=>[
  primaryKey({columns:[t.notification_id,t.admin_id]}),
  index('admin_notification_reads_admin_idx').on(t.admin_id,t.notification_id),
]);

export const line_messages = sqliteTable('line_messages', {
  id: text('id').primaryKey().notNull(),
  company_id: text('company_id').notNull().references(()=>companies.id),
  line_user_id: text('line_user_id').notNull().references(()=>line_users.id),
  direction: text('direction').notNull(),
  message_type: text('message_type').notNull().default('text'),
  text: text('text').notNull(),
  status: text('status').notNull(),
  request_id: text('request_id').unique(),
  webhook_event_id: text('webhook_event_id').unique(),
  line_message_id: text('line_message_id').unique(),
  notification_event_key: text('notification_event_key').unique(),
  created_at: text('created_at').notNull(),
  sent_at: text('sent_at'),
  error_code: text('error_code'),
  send_claim_id: text('send_claim_id'),
  send_claimed_at: text('send_claimed_at'),
  attempt_count: integer('attempt_count').notNull().default(0),
},(t)=>[
  check('line_messages_direction',sql`direction IN ('incoming','outgoing')`),
  check('line_messages_length',sql`length(text)<=5000`),
  check('line_messages_status',sql`status IN ('received','pending','sent','failed','unknown')`),
  check('line_messages_attempts',sql`attempt_count>=0`),
  check('line_messages_direction_status',sql`(direction='incoming' AND status='received') OR (direction='outgoing' AND request_id IS NOT NULL)`),
  index('line_messages_conversation_idx').on(t.company_id,t.line_user_id,t.created_at),
]);
export const line_message_unsends = sqliteTable('line_message_unsends', {
  line_message_id: text('line_message_id').notNull(),
  line_user_id: text('line_user_id').notNull().references(()=>line_users.id),
  created_at: text('created_at').notNull(),
},(t)=>[primaryKey({columns:[t.line_message_id,t.line_user_id]})]);

export const system_state = sqliteTable('system_state', {
  id: integer('id').primaryKey().notNull(),
  generation: integer('generation').notNull().default(0),
  data_revision: integer('data_revision').notNull().default(0),
}, (t) => [
  check('system_state_singleton', sql`id = 1`),
  check('system_state_generation', sql`generation >= 0`),
  check('system_state_revision', sql`data_revision >= 0`),
]);
export const system_task_leases = sqliteTable('system_task_leases', {
  id: text('id').primaryKey().notNull(),
  generation: integer('generation').notNull(),
  kind: text('kind').notNull(),
  expires_at: text('expires_at').notNull(),
}, (t) => [
  check('system_task_leases_generation', sql`generation >= 0`),
  index('system_task_leases_expires_idx').on(t.expires_at),
]);
export const system_reset_challenges = sqliteTable('system_reset_challenges', {
  token_hash: text('token_hash').primaryKey().notNull(),
  admin_id: text('admin_id').notNull().references(() => admins.id),
  session_version: integer('session_version').notNull(),
  credential_fingerprint: text('credential_fingerprint').notNull(),
  generation: integer('generation').notNull(),
  data_revision: integer('data_revision').notNull(),
  counts_json: text('counts_json').notNull(),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
}, (t) => [
  check('system_reset_challenges_hash', sql`length(token_hash) = 64`),
  check('system_reset_challenges_session', sql`session_version >= 0`),
  check('system_reset_challenges_credential', sql`length(credential_fingerprint) = 64`),
  check('system_reset_challenges_generation', sql`generation >= 0`),
  check('system_reset_challenges_revision', sql`data_revision >= 0`),
  check('system_reset_challenges_counts', sql`json_valid(counts_json)`),
  check('system_reset_challenges_lifetime', sql`expires_at > created_at`),
  index('system_reset_challenges_admin_idx').on(t.admin_id),
  index('system_reset_challenges_expires_idx').on(t.expires_at),
]);

export const schema = { admins, companies, shipping_rules, shipping_addresses, invitations, line_users, contracts, products, company_product_prices, delivery_calendar, packaging_boxes, yamato_sizes, yamato_rates, orders, order_items, order_packages, order_package_items, order_revisions, order_requests, invoices, invoice_items, invoice_histories, delivery_note_histories, audit_logs, company_info, settings, report_settings, email_notification_config, gmail_oauth_states, admin_notifications, admin_notification_reads, line_messages, line_message_unsends, system_state, system_task_leases, system_reset_challenges };
