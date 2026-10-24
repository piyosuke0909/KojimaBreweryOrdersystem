-- Preserve all existing amounts. Unknown historic tax policies and request bodies stay unknown.
ALTER TABLE line_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK(session_version >= 0);
ALTER TABLE line_users ADD COLUMN registration_handoff_hash TEXT CHECK(registration_handoff_hash IS NULL OR length(registration_handoff_hash) = 64);
ALTER TABLE orders ADD COLUMN request_hash TEXT CHECK(request_hash IS NULL OR length(request_hash) = 64);
ALTER TABLE orders ADD COLUMN snap_shipping_taxable INTEGER CHECK(snap_shipping_taxable IS NULL OR snap_shipping_taxable IN (0,1));
