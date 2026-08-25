CREATE TABLE IF NOT EXISTS polybill_migration_reports (
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plan_id)
);
