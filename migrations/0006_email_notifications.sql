-- Mail credentials stay separate from generic settings and are encrypted by the Worker.
CREATE TABLE email_notification_config (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  provider TEXT NOT NULL DEFAULT 'gmail' CHECK(provider IN ('gmail','resend')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  recipients_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(recipients_json)),
  sender_email TEXT NOT NULL DEFAULT '',
  notify_created INTEGER NOT NULL DEFAULT 1 CHECK(notify_created IN (0,1)),
  notify_edited INTEGER NOT NULL DEFAULT 0 CHECK(notify_edited IN (0,1)),
  notify_cancelled INTEGER NOT NULL DEFAULT 1 CHECK(notify_cancelled IN (0,1)),
  gmail_client_id TEXT NOT NULL DEFAULT '',
  gmail_client_secret_ciphertext TEXT,
  gmail_refresh_token_ciphertext TEXT,
  app_origin TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE gmail_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK(length(state_hash)=64),
  admin_id TEXT NOT NULL REFERENCES admins(id),
  code_verifier_ciphertext TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX gmail_oauth_states_expires_idx ON gmail_oauth_states(expires_at);
