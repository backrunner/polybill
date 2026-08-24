CREATE TABLE IF NOT EXISTS polybill_x402_notify_nonces (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  nonce_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, nonce_key)
);

CREATE INDEX IF NOT EXISTS polybill_x402_notify_nonces_expiry
  ON polybill_x402_notify_nonces (expires_at);

ALTER TABLE polybill_vouchers ADD COLUMN update_token TEXT;

CREATE TABLE IF NOT EXISTS polybill_x402_transactions (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, tx_hash),
  UNIQUE (tenant_id, connection_id, order_id, tx_hash)
);
