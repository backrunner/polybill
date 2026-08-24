ALTER TABLE polybill_migration_items ADD COLUMN lease_token TEXT;
ALTER TABLE polybill_migration_items ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE polybill_migration_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS polybill_migration_routing (
  tenant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id)
);
