import type { ResourceCommit } from "@polybill/application";
import { PolybillError } from "@polybill/core";
import type { D1DatabaseLike } from "./d1.js";

export async function insertResource(db: D1DatabaseLike, commit: ResourceCommit): Promise<void> {
  if (commit.externalId !== undefined) {
    await db
      .prepare(
        "INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, ?, ?, ?, 1, 'observed') ON CONFLICT DO NOTHING",
      )
      .bind(
        commit.tenantId,
        commit.connectionId,
        commit.entityType,
        commit.entityId,
        commit.externalId,
      )
      .run();
    const row = await db
      .prepare(
        "SELECT external_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type = ? AND entity_id = ?",
      )
      .bind(commit.tenantId, commit.connectionId, commit.entityType, commit.entityId)
      .first<{ external_id: string }>();
    if (row?.external_id !== commit.externalId)
      throw new PolybillError("Resource mapping conflicts with existing identity", {
        code: "conflict",
        operation: "resource.insert",
        retryable: false,
      });
  }
  // Both steps are insert-only and replay safe after a crash between mapping and snapshot.
  await db
    .prepare(
      "INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(
      commit.tenantId,
      commit.entityType,
      commit.entityId,
      commit.occurredAt,
      JSON.stringify(commit.value),
    )
    .run();
}
