CREATE TABLE IF NOT EXISTS polybill_discount_redemptions (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  redemption_id TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  customer_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'finalized', 'released')),
  redemption_count_before INTEGER NOT NULL,
  customer_redemption_count_before INTEGER NOT NULL,
  reserved_at TEXT NOT NULL,
  finalized_at TEXT,
  order_id TEXT,
  PRIMARY KEY (tenant_id, redemption_id),
  UNIQUE (tenant_id, connection_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS polybill_discount_redemptions_limit
  ON polybill_discount_redemptions (tenant_id, discount_id, status);

CREATE INDEX IF NOT EXISTS polybill_discount_redemptions_customer_limit
  ON polybill_discount_redemptions (tenant_id, discount_id, customer_ref, status);
