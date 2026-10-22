-- Preserve an authenticated invitation while moving from Safari/Chrome to LINE.
-- The QR remains valid independently; this short-lived state contains no token.
CREATE TABLE line_invitation_handoffs (
  subject_hash TEXT PRIMARY KEY NOT NULL CHECK(length(subject_hash) = 64),
  handoff_id TEXT UNIQUE NOT NULL,
  invitation_id TEXT NOT NULL REFERENCES invitations(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX line_invitation_handoffs_expires_idx ON line_invitation_handoffs(expires_at);
