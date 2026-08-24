CREATE TABLE IF NOT EXISTS polybill_discounts (
  tenant_id TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  issuance_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  update_token TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, discount_id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, issuance_key)
);

CREATE TABLE IF NOT EXISTS polybill_discount_actions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
