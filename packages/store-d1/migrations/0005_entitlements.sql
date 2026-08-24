ALTER TABLE polybill_entitlement_policies ADD COLUMN issuance_key TEXT;
ALTER TABLE polybill_entitlement_policies ADD COLUMN payload_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS polybill_entitlement_policy_issuance
  ON polybill_entitlement_policies (tenant_id, issuance_key);

CREATE TABLE polybill_entitlement_grants_v2 (
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  issuance_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  update_token TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, grant_id),
  UNIQUE (tenant_id, issuance_key),
  UNIQUE (tenant_id, policy_id, source, source_ref)
);

INSERT INTO polybill_entitlement_grants_v2
  (tenant_id, grant_id, policy_id, source, source_ref, status, issuance_key, payload_hash, value)
SELECT tenant_id, grant_id, json_extract(value, '$.policyId'), source, source_ref, status,
  'legacy:' || grant_id, '', json_set(value, '$.updatedAt', json_extract(value, '$.grantedAt'))
FROM polybill_entitlement_grants;

DROP TABLE polybill_entitlement_grants;
ALTER TABLE polybill_entitlement_grants_v2 RENAME TO polybill_entitlement_grants;

CREATE TABLE IF NOT EXISTS polybill_entitlement_transitions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
