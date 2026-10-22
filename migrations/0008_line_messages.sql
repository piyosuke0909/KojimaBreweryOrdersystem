-- Provider identities remain on line_users. Messages reference its internal id.
CREATE TABLE line_messages (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id),
  line_user_id TEXT NOT NULL REFERENCES line_users(id),
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  message_type TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL CHECK(length(text)<=5000),
  status TEXT NOT NULL CHECK(status IN ('received','pending','sent','failed','unknown')),
  request_id TEXT UNIQUE,
  webhook_event_id TEXT UNIQUE,
  line_message_id TEXT UNIQUE,
  notification_event_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  error_code TEXT,
  send_claim_id TEXT,
  send_claimed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  CHECK((direction='incoming' AND status='received') OR (direction='outgoing' AND request_id IS NOT NULL))
);
CREATE INDEX line_messages_conversation_idx ON line_messages(company_id,line_user_id,created_at);
CREATE TABLE line_message_unsends (
  line_message_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL REFERENCES line_users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(line_message_id,line_user_id)
);
