CREATE TABLE IF NOT EXISTS polybill_inbox_v2 (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  external_delivery_key TEXT NOT NULL,
  provider_event_id TEXT,
  received_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  raw_body_digest TEXT NOT NULL,
  raw_body BLOB,
  verification_key_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('processing', 'retry_wait', 'dead_letter', 'applied')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  PRIMARY KEY (tenant_id, connection_id, environment, external_delivery_key)
);

INSERT OR IGNORE INTO polybill_inbox_v2
  (tenant_id, connection_id, environment, external_delivery_key, provider_event_id, received_at, verified_at, raw_body_digest, raw_body, verification_key_id, state, attempts, last_error_code)
  SELECT tenant_id, connection_id, environment, external_delivery_key, provider_event_id, received_at, verified_at, raw_body_digest, raw_body, verification_key_id, state, attempts, last_error_code
  FROM polybill_inbox;

DROP TABLE polybill_inbox;
ALTER TABLE polybill_inbox_v2 RENAME TO polybill_inbox;

CREATE INDEX IF NOT EXISTS polybill_inbox_tenant_state
  ON polybill_inbox (tenant_id, state, received_at);
