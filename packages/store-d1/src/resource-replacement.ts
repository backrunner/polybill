import type { ResourceReplacement } from "@polybill/application";
import { PolybillError } from "@polybill/core";
import type { D1DatabaseLike } from "./d1.js";
import type { D1PersistenceWriter } from "./persistence-adapter.js";

export async function replaceResource(
  db: D1DatabaseLike,
  writes: D1PersistenceWriter,
  commit: ResourceReplacement,
): Promise<void> {
  if (
    !Number.isSafeInteger(commit.expectedVersion) ||
    commit.expectedVersion < 1 ||
    !Number.isSafeInteger(commit.value.version) ||
    commit.value.version !== commit.expectedVersion + 1
  )
    throw new TypeError("Invalid resource replacement version");
  const predicate = `tenant_id = ? AND aggregate_type = ? AND aggregate_id = ?
    AND json_extract(snapshot, '$.version') = ?
    AND EXISTS (SELECT 1 FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ?
      AND entity_type = ? AND entity_id = ? AND external_id = ?)`;
  const scope = [
    commit.tenantId,
    commit.entityType,
    commit.entityId,
    commit.expectedVersion,
    commit.tenantId,
    commit.connectionId,
    commit.entityType,
    commit.entityId,
    commit.externalId,
  ];
  // An observation records evidence; only the guarded UPDATE establishes the projection.
  const audit = db
    .prepare(
      `INSERT INTO polybill_audit (tenant_id, operation, evidence, occurred_at)
    SELECT ?, ?, ?, ? FROM polybill_snapshots WHERE ${predicate}`,
    )
    .bind(
      commit.tenantId,
      `${commit.entityType}.observe`,
      JSON.stringify({ provider: commit.provider, value: commit.evidence ?? null }),
      commit.occurredAt,
      ...scope,
    );
  const update = db
    .prepare(
      `UPDATE polybill_snapshots SET version = version + 1, observed_at = ?, snapshot = ?
    WHERE ${predicate}`,
    )
    .bind(commit.occurredAt, JSON.stringify(commit.value), ...scope);
  const results = await writes.execute([audit, update], "resource.replace");
  if (results[1]?.meta?.changes !== 1)
    throw new PolybillError("Canonical resource changed before replacement", {
      code: "conflict",
      operation: "resource.replace",
      provider: commit.provider,
      retryable: true,
    });
}
