-- A request captures this generation. Old requests may never repopulate reset data.
CREATE TABLE system_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision>=0)
);
INSERT INTO system_state(id) VALUES(1);

-- External sends hold a short, renewed lease; reset waits for their completion.
CREATE TABLE system_task_leases (
  id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX system_task_leases_expires_idx ON system_task_leases(expires_at);

-- Only a digest of the random one-use token is stored. No password is persisted here.
CREATE TABLE system_reset_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
  admin_id TEXT NOT NULL REFERENCES admins(id),
  session_version INTEGER NOT NULL CHECK(session_version>=0),
  credential_fingerprint TEXT NOT NULL CHECK(length(credential_fingerprint)=64),
  generation INTEGER NOT NULL CHECK(generation>=0),
  data_revision INTEGER NOT NULL CHECK(data_revision>=0),
  counts_json TEXT NOT NULL CHECK(json_valid(counts_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX system_reset_challenges_admin_idx ON system_reset_challenges(admin_id);
CREATE INDEX system_reset_challenges_expires_idx ON system_reset_challenges(expires_at);
