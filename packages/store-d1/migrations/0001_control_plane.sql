PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS polybill_connections (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  account_ref TEXT,
  configuration TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id)
);

CREATE TABLE IF NOT EXISTS polybill_inbox (
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
  PRIMARY KEY (connection_id, external_delivery_key)
);

CREATE INDEX IF NOT EXISTS polybill_inbox_tenant_state
  ON polybill_inbox (tenant_id, state, received_at);

CREATE TABLE IF NOT EXISTS polybill_outbox (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  PRIMARY KEY (event_id, destination)
);

CREATE TABLE IF NOT EXISTS polybill_idempotency (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'unknown', 'complete')),
  lease_token TEXT NOT NULL,
  recovery_context TEXT,
  result TEXT,
  evidence TEXT,
  PRIMARY KEY (tenant_id, connection_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS polybill_mappings (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  mapping_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('created', 'imported', 'observed')),
  PRIMARY KEY (tenant_id, connection_id, entity_type, entity_id),
  UNIQUE (tenant_id, connection_id, entity_type, external_id)
);

CREATE TABLE IF NOT EXISTS polybill_snapshots (
  tenant_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (tenant_id, aggregate_type, aggregate_id)
);

CREATE TABLE IF NOT EXISTS polybill_catalog_products (
  tenant_id TEXT NOT NULL, product_id TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, product_id)
);
CREATE TABLE IF NOT EXISTS polybill_catalog_skus (
  tenant_id TEXT NOT NULL, sku_id TEXT NOT NULL, product_id TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sku_id)
);
CREATE TABLE IF NOT EXISTS polybill_catalog_prices (
  tenant_id TEXT NOT NULL, price_id TEXT NOT NULL, sku_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, price_id)
);

CREATE TABLE IF NOT EXISTS polybill_entitlement_policies (
  tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, policy_id)
);
CREATE TABLE IF NOT EXISTS polybill_entitlement_grants (
  tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, grant_id), UNIQUE (tenant_id, source, source_ref)
);

CREATE TABLE IF NOT EXISTS polybill_licenses (
  tenant_id TEXT NOT NULL, license_id TEXT NOT NULL, digest TEXT NOT NULL, encrypted_value TEXT NOT NULL,
  status TEXT NOT NULL, activation_limit INTEGER NOT NULL, expires_at TEXT, grant_id TEXT NOT NULL,
  issuance_key TEXT NOT NULL, payload_hash TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, license_id), UNIQUE (tenant_id, digest), UNIQUE (tenant_id, issuance_key)
);
CREATE TABLE IF NOT EXISTS polybill_license_instances (
  tenant_id TEXT NOT NULL, instance_id TEXT NOT NULL, license_id TEXT NOT NULL, instance_ref TEXT NOT NULL,
  device_digest TEXT NOT NULL, activated_at TEXT NOT NULL, last_validated_at TEXT NOT NULL, deactivated_at TEXT,
  PRIMARY KEY (tenant_id, instance_id), UNIQUE (tenant_id, license_id, instance_ref)
);

CREATE TABLE IF NOT EXISTS polybill_voucher_batches (
  tenant_id TEXT NOT NULL, batch_id TEXT NOT NULL, issuance_key TEXT NOT NULL, payload_hash TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, batch_id), UNIQUE (tenant_id, issuance_key)
);
CREATE TABLE IF NOT EXISTS polybill_vouchers (
  tenant_id TEXT NOT NULL, voucher_id TEXT NOT NULL, batch_id TEXT NOT NULL, digest TEXT NOT NULL,
  encrypted_value TEXT NOT NULL, status TEXT NOT NULL, remaining_uses INTEGER NOT NULL,
  remaining_amount TEXT, remaining_currency TEXT, expires_at TEXT, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, voucher_id), UNIQUE (tenant_id, digest)
);
CREATE TABLE IF NOT EXISTS polybill_voucher_redemptions (
  tenant_id TEXT NOT NULL, redemption_id TEXT NOT NULL, voucher_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, redemption_id), UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS polybill_migration_plans (
  tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plan_id)
);
CREATE TABLE IF NOT EXISTS polybill_migration_items (
  tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, item_key TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, plan_id, item_key)
);
CREATE TABLE IF NOT EXISTS polybill_migration_checkpoints (
  tenant_id TEXT NOT NULL, plan_id TEXT NOT NULL, stream TEXT NOT NULL, cursor TEXT, sequence INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plan_id, stream)
);

CREATE TABLE IF NOT EXISTS polybill_audit (
  tenant_id TEXT NOT NULL,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  actor_ref TEXT,
  evidence TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

PRAGMA user_version = 1;
