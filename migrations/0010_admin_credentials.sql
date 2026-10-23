-- A per-administrator generation revokes old sessions after credential changes.
ALTER TABLE admins ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK(session_version>=0);
