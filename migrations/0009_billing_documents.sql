-- Presentation revisions never alter financial snapshots or their locked orders.
ALTER TABLE invoice_histories ADD COLUMN request_id TEXT;
ALTER TABLE invoice_histories ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX invoice_histories_request_id_uniq ON invoice_histories(request_id) WHERE request_id IS NOT NULL;

-- A GET preview is a draft. Only explicit issuance creates one immutable record.
CREATE TABLE delivery_note_histories (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  invoice_id TEXT REFERENCES invoices(id),
  version INTEGER NOT NULL CHECK(version>0),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL REFERENCES admins(id),
  source_order_version INTEGER NOT NULL CHECK(source_order_version>0),
  source_invoice_version INTEGER CHECK(source_invoice_version IS NULL OR source_invoice_version>0),
  CHECK((invoice_id IS NULL AND source_invoice_version IS NULL) OR (invoice_id IS NOT NULL AND source_invoice_version IS NOT NULL)),
  UNIQUE(order_id,version)
);
CREATE INDEX delivery_note_histories_invoice_idx ON delivery_note_histories(invoice_id,issued_at DESC);
