-- Shared events with a separate read receipt for every administrator.
-- Existing orders/messages are deliberately not backfilled as unread events.
CREATE TABLE admin_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('order_created','order_updated','order_cancelled','line_message')),
  category TEXT NOT NULL CHECK(category IN ('orders','companies')),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
  line_user_id TEXT REFERENCES line_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK((category='orders' AND order_id IS NOT NULL AND kind IN ('order_created','order_updated','order_cancelled'))
     OR (category='companies' AND line_user_id IS NOT NULL AND kind='line_message'))
);
CREATE INDEX admin_notifications_created_idx ON admin_notifications(created_at DESC,id DESC);
CREATE INDEX admin_notifications_thread_idx ON admin_notifications(company_id,line_user_id,kind);
CREATE TABLE admin_notification_reads (
  notification_id TEXT NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY(notification_id,admin_id)
);
CREATE INDEX admin_notification_reads_admin_idx ON admin_notification_reads(admin_id,notification_id);
