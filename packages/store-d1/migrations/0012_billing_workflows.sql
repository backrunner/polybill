CREATE TABLE IF NOT EXISTS polybill_billing_records (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('test', 'live')),
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  due_at TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, environment, kind, id)
);
CREATE INDEX IF NOT EXISTS polybill_billing_due ON polybill_billing_records
  (tenant_id, connection_id, environment, kind, due_at, id);

CREATE TABLE IF NOT EXISTS polybill_credit_entries (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('test', 'live')),
  id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  balance TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, environment, id),
  UNIQUE (tenant_id, connection_id, environment, customer_id, unit, revision)
);
