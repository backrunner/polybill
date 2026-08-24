CREATE TABLE IF NOT EXISTS polybill_reconciliation_checkpoints (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor TEXT,
  sequence INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, stream)
);
