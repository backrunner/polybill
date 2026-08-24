import type {
  ApplicationStore,
  CheckoutCommit,
  IdempotencyClaim,
  IdempotencyScope,
  ResourceCommit,
  ReconciliationTarget,
} from "@polybill/application";
import type { CheckoutSession, Price, TenantId } from "@polybill/core";
import type { D1DatabaseLike, D1Result } from "./d1.js";

interface IdempotencyRow {
  readonly payload_hash: string;
  readonly state: "claimed" | "unknown" | "complete";
  readonly lease_token: string;
  readonly recovery_context: string | null;
  readonly result: string | null;
  readonly evidence: string | null;
}

export interface D1ApplicationStoreOptions {
  readonly leaseToken?: () => string;
}

export class D1ApplicationStore implements ApplicationStore {
  readonly #db: D1DatabaseLike;
  readonly #leaseToken: () => string;

  constructor(db: D1DatabaseLike, options: D1ApplicationStoreOptions = {}) {
    this.#db = db;
    this.#leaseToken = options.leaseToken ?? (() => `lease_${globalThis.crypto.randomUUID()}`);
  }

  async claim(scope: IdempotencyScope, payloadHash: string): Promise<IdempotencyClaim> {
    const leaseToken = this.#leaseToken();
    const inserted = await this.#db
      .prepare(
        `INSERT INTO polybill_idempotency (tenant_id, connection_id, operation, idempotency_key, payload_hash, state, lease_token) VALUES (?, ?, ?, ?, ?, 'claimed', ?) ON CONFLICT(tenant_id, connection_id, operation, idempotency_key) DO NOTHING`,
      )
      .bind(scope.tenantId, scope.connectionId, scope.operation, scope.key, payloadHash, leaseToken)
      .run();
    if (changes(inserted) === 1) return { kind: "claimed", leaseToken };
    const row = await this.#row(scope);
    if (row === null) throw new Error("D1 idempotency claim disappeared");
    if (row.payload_hash !== payloadHash) return { kind: "conflict" };
    if (row.state === "claimed") return { kind: "in_progress" };
    if (row.state === "complete")
      return { kind: "replay", result: parseStored(row.result, "idempotency result") };
    return {
      kind: "outcome_unknown",
      leaseToken: row.lease_token,
      recoveryContext: parseStored(row.recovery_context, "recovery context"),
      ...(row.evidence === null ? {} : { evidence: row.evidence }),
    };
  }

  async saveRecoveryContext(
    scope: IdempotencyScope,
    leaseToken: string,
    recoveryContext: unknown,
  ): Promise<void> {
    await this.#ownedUpdate(
      scope,
      leaseToken,
      "UPDATE polybill_idempotency SET recovery_context = ? WHERE tenant_id = ? AND connection_id = ? AND operation = ? AND idempotency_key = ? AND lease_token = ? AND state = 'claimed'",
      JSON.stringify(recoveryContext),
    );
  }

  async complete(scope: IdempotencyScope, leaseToken: string, result: unknown): Promise<void> {
    await this.#ownedUpdate(
      scope,
      leaseToken,
      "UPDATE polybill_idempotency SET state = 'complete', result = ? WHERE tenant_id = ? AND connection_id = ? AND operation = ? AND idempotency_key = ? AND lease_token = ? AND state IN ('claimed', 'unknown')",
      JSON.stringify(result),
    );
  }

  async markUnknown(scope: IdempotencyScope, leaseToken: string, evidence?: string): Promise<void> {
    const result = await this.#db
      .prepare(
        "UPDATE polybill_idempotency SET state = 'unknown', evidence = ? WHERE tenant_id = ? AND connection_id = ? AND operation = ? AND idempotency_key = ? AND lease_token = ? AND state = 'claimed'",
      )
      .bind(
        evidence ?? null,
        scope.tenantId,
        scope.connectionId,
        scope.operation,
        scope.key,
        leaseToken,
      )
      .run();
    assertOwned(result);
  }

  async release(scope: IdempotencyScope, leaseToken: string): Promise<void> {
    const result = await this.#db
      .prepare(
        "DELETE FROM polybill_idempotency WHERE tenant_id = ? AND connection_id = ? AND operation = ? AND idempotency_key = ? AND lease_token = ? AND state = 'claimed'",
      )
      .bind(scope.tenantId, scope.connectionId, scope.operation, scope.key, leaseToken)
      .run();
    assertOwned(result);
  }

  async getPrice(tenantId: TenantId, priceId: string): Promise<Price | undefined> {
    const catalog = await this.#db
      .prepare("SELECT value FROM polybill_catalog_prices WHERE tenant_id = ? AND price_id = ?")
      .bind(tenantId, priceId)
      .first<{ value: string }>();
    if (catalog !== null) return decodePrice(catalog.value);
    const snapshot = await this.#db
      .prepare(
        "SELECT snapshot AS value FROM polybill_snapshots WHERE tenant_id = ? AND aggregate_type = 'price' AND aggregate_id = ?",
      )
      .bind(tenantId, priceId)
      .first<{ value: string }>();
    return snapshot === null ? undefined : decodePrice(snapshot.value);
  }

  async getExternalId(
    tenantId: TenantId,
    connectionId: string,
    entityType: string,
    entityId: string,
  ): Promise<string | undefined> {
    const row = await this.#db
      .prepare(
        "SELECT external_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type = ? AND entity_id = ?",
      )
      .bind(tenantId, connectionId, entityType, entityId)
      .first<{ external_id: string }>();
    return row?.external_id;
  }

  async findCanonicalId(
    tenantId: TenantId,
    connectionId: string,
    entityType: string,
    externalId: string,
  ): Promise<string | undefined> {
    const row = await this.#db
      .prepare(
        "SELECT entity_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type = ? AND external_id = ?",
      )
      .bind(tenantId, connectionId, entityType, externalId)
      .first<{ entity_id: string }>();
    return row?.entity_id;
  }

  async commitResource(commit: ResourceCommit): Promise<void> {
    const statements = [
      ...(commit.externalId === undefined
        ? []
        : [
            this.#db
              .prepare(
                `INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, ?, ?, ?, 1, 'created') ON CONFLICT(tenant_id, connection_id, entity_type, entity_id) DO UPDATE SET external_id = excluded.external_id, mapping_version = polybill_mappings.mapping_version + 1 WHERE polybill_mappings.external_id = excluded.external_id`,
              )
              .bind(
                commit.tenantId,
                commit.connectionId,
                commit.entityType,
                commit.entityId,
                commit.externalId,
              ),
          ]),
      this.#db
        .prepare(
          `INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(tenant_id, aggregate_type, aggregate_id) DO UPDATE SET version = polybill_snapshots.version + 1, observed_at = excluded.observed_at, snapshot = excluded.snapshot`,
        )
        .bind(
          commit.tenantId,
          commit.entityType,
          commit.entityId,
          commit.occurredAt,
          JSON.stringify(commit.value),
        ),
      this.#db
        .prepare(
          "INSERT INTO polybill_audit (tenant_id, operation, evidence, occurred_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          commit.tenantId,
          `${commit.entityType}.commit`,
          JSON.stringify({ provider: commit.provider, value: commit.evidence ?? null }),
          commit.occurredAt,
        ),
    ];
    await this.#db.batch(statements);
  }

  async listReconciliationTargets(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly after?: string;
    readonly limit: number;
  }) {
    const result = await this.#db
      .prepare(
        `SELECT entity_type, entity_id, external_id FROM polybill_mappings WHERE tenant_id = ? AND connection_id = ? AND entity_type IN ('customer', 'subscription', 'refund') AND (entity_type || ':' || entity_id) > ? ORDER BY entity_type, entity_id LIMIT ?`,
      )
      .bind(input.tenantId, input.connectionId, input.after ?? "", input.limit)
      .all<{
        entity_type: ReconciliationTarget["entityType"];
        entity_id: string;
        external_id: string;
      }>();
    const items = (result.results ?? []).map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      externalId: row.external_id,
    }));
    const last = items[items.length - 1];
    return {
      items,
      ...(last !== undefined ? { nextCursor: `${last.entityType}:${last.entityId}` } : {}),
    };
  }

  async getReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly stream: string;
  }) {
    const row = await this.#db
      .prepare(
        "SELECT cursor, sequence FROM polybill_reconciliation_checkpoints WHERE tenant_id = ? AND connection_id = ? AND stream = ?",
      )
      .bind(input.tenantId, input.connectionId, input.stream)
      .first<{ cursor: string | null; sequence: number }>();
    return row === null
      ? undefined
      : { ...(row.cursor === null ? {} : { cursor: row.cursor }), sequence: row.sequence };
  }

  async saveReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly stream: string;
    readonly cursor?: string;
    readonly sequence: number;
    readonly observedAt: string;
  }): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO polybill_reconciliation_checkpoints (tenant_id, connection_id, stream, cursor, sequence, observed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, connection_id, stream) DO UPDATE SET cursor = excluded.cursor, sequence = excluded.sequence, observed_at = excluded.observed_at WHERE excluded.sequence >= polybill_reconciliation_checkpoints.sequence`,
      )
      .bind(
        input.tenantId,
        input.connectionId,
        input.stream,
        input.cursor ?? null,
        input.sequence,
        input.observedAt,
      )
      .run();
  }

  async getResource<T>(
    tenantId: TenantId,
    entityType: string,
    entityId: string,
  ): Promise<T | undefined> {
    const row = await this.#db
      .prepare(
        "SELECT snapshot FROM polybill_snapshots WHERE tenant_id = ? AND aggregate_type = ? AND aggregate_id = ?",
      )
      .bind(tenantId, entityType, entityId)
      .first<{ snapshot: string }>();
    if (row === null) return undefined;
    try {
      return JSON.parse(row.snapshot) as T;
    } catch {
      throw new TypeError("Stored D1 canonical resource is invalid JSON");
    }
  }

  async commitCheckout(commit: CheckoutCommit): Promise<void> {
    await this.#db.batch([
      this.#db
        .prepare(
          "INSERT INTO polybill_mappings (tenant_id, connection_id, entity_type, entity_id, external_id, mapping_version, source) VALUES (?, ?, 'checkout', ?, ?, 1, 'created')",
        )
        .bind(commit.tenantId, commit.connectionId, commit.checkout.id, commit.externalCheckoutId),
      this.#db
        .prepare(
          "INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, 'checkout', ?, 1, ?, ?)",
        )
        .bind(
          commit.tenantId,
          commit.checkout.id,
          commit.occurredAt,
          JSON.stringify(commit.checkout),
        ),
      this.#db
        .prepare(
          "INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, 'order', ?, 1, ?, ?)",
        )
        .bind(commit.tenantId, commit.order.id, commit.occurredAt, JSON.stringify(commit.order)),
      this.#db
        .prepare(
          "INSERT INTO polybill_snapshots (tenant_id, aggregate_type, aggregate_id, version, observed_at, snapshot) VALUES (?, 'payment', ?, 1, ?, ?)",
        )
        .bind(
          commit.tenantId,
          commit.payment.id,
          commit.occurredAt,
          JSON.stringify(commit.payment),
        ),
      this.#db
        .prepare(
          "INSERT INTO polybill_audit (tenant_id, operation, evidence, occurred_at) VALUES (?, 'checkout.commit', ?, ?)",
        )
        .bind(
          commit.tenantId,
          JSON.stringify({
            evidenceId: commit.evidenceId,
            provider: commit.provider,
            value: commit.evidence,
          }),
          commit.occurredAt,
        ),
    ]);
  }

  async getCheckout(tenantId: TenantId, checkoutId: string): Promise<CheckoutSession | undefined> {
    const row = await this.#db
      .prepare(
        "SELECT snapshot FROM polybill_snapshots WHERE tenant_id = ? AND aggregate_type = 'checkout' AND aggregate_id = ?",
      )
      .bind(tenantId, checkoutId)
      .first<{ snapshot: string }>();
    return row === null ? undefined : decodeCheckout(row.snapshot);
  }

  async #row(scope: IdempotencyScope): Promise<IdempotencyRow | null> {
    return this.#db
      .prepare(
        "SELECT payload_hash, state, lease_token, recovery_context, result, evidence FROM polybill_idempotency WHERE tenant_id = ? AND connection_id = ? AND operation = ? AND idempotency_key = ?",
      )
      .bind(scope.tenantId, scope.connectionId, scope.operation, scope.key)
      .first<IdempotencyRow>();
  }

  async #ownedUpdate(
    scope: IdempotencyScope,
    leaseToken: string,
    query: string,
    value: string,
  ): Promise<void> {
    const result = await this.#db
      .prepare(query)
      .bind(value, scope.tenantId, scope.connectionId, scope.operation, scope.key, leaseToken)
      .run();
    assertOwned(result);
  }
}

function decodePrice(value: string): Price {
  const parsed = parseStored(value, "catalog price");
  if (
    !record(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.skuId !== "string" ||
    typeof parsed.version !== "number" ||
    !record(parsed.model) ||
    typeof parsed.model.kind !== "string" ||
    (parsed.status !== "active" && parsed.status !== "retired")
  )
    throw new TypeError("Stored D1 catalog price is invalid");
  return parsed as unknown as Price;
}

function decodeCheckout(value: string): CheckoutSession {
  const parsed = parseStored(value, "checkout snapshot");
  if (
    !record(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.orderId !== "string" ||
    !["open", "complete", "expired", "canceled"].includes(String(parsed.status))
  )
    throw new TypeError("Stored D1 checkout snapshot is invalid");
  return parsed as unknown as CheckoutSession;
}

function parseStored(value: string | null, name: string): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`Stored D1 ${name} is invalid JSON`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changes(result: D1Result): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

function assertOwned(result: D1Result): void {
  if (changes(result) !== 1) throw new Error("D1 idempotency lease lost");
}
