import type { EntitlementGrantId, EntitlementPolicyId, TenantId } from "@polybill/core";
import type {
  CreateEntitlementGrantResult,
  CreateEntitlementPolicyResult,
  EntitlementGrant,
  EntitlementPolicy,
  EntitlementStore,
  TransitionEntitlementGrantResult,
} from "@polybill/licensing";
import type { D1DatabaseLike } from "./d1.js";
import { decodeEntitlementGrant, decodeEntitlementPolicy } from "./licensing-codecs.js";
import { createD1PersistenceAdapter, type D1PersistenceWriter } from "./persistence-adapter.js";

export class D1EntitlementStore implements EntitlementStore {
  readonly #db: D1DatabaseLike;
  readonly #writes: D1PersistenceWriter;

  constructor(db: D1DatabaseLike, options: { readonly writes?: D1PersistenceWriter } = {}) {
    this.#db = db;
    this.#writes = options.writes ?? createD1PersistenceAdapter(db);
  }

  async createEntitlementPolicy(
    tenantId: TenantId,
    policy: EntitlementPolicy,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementPolicyResult> {
    const existing = await this.#policyByIssuance(tenantId, idempotencyKey);
    if (existing !== null) return policyReplay(existing, payloadHash);
    try {
      await this.#db
        .prepare(
          "INSERT INTO polybill_entitlement_policies (tenant_id, policy_id, value, issuance_key, payload_hash) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(tenantId, policy.id, JSON.stringify(policy), idempotencyKey, payloadHash)
        .run();
      return { kind: "created", policy };
    } catch (error) {
      const raced = await this.#policyByIssuance(tenantId, idempotencyKey);
      if (raced === null) throw error;
      return policyReplay(raced, payloadHash);
    }
  }

  async getEntitlementPolicy(
    tenantId: TenantId,
    policyId: EntitlementPolicyId,
  ): Promise<EntitlementPolicy | undefined> {
    const row = await this.#db
      .prepare(
        "SELECT value FROM polybill_entitlement_policies WHERE tenant_id = ? AND policy_id = ?",
      )
      .bind(tenantId, policyId)
      .first<{ value: string }>();
    return row === null ? undefined : decodeEntitlementPolicy(row.value);
  }

  async createEntitlementGrant(
    grant: EntitlementGrant,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementGrantResult> {
    const existing = await this.#grantByIssuance(grant.tenantId, idempotencyKey);
    if (existing !== null) return grantReplay(existing, payloadHash);
    const source = await this.#grantBySource(grant);
    if (source !== null) return { kind: "conflict" };
    if ((await this.getEntitlementPolicy(grant.tenantId, grant.policyId)) === undefined)
      return { kind: "policy_not_found" };
    try {
      await this.#db
        .prepare(
          "INSERT INTO polybill_entitlement_grants (tenant_id, grant_id, policy_id, source, source_ref, status, issuance_key, payload_hash, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          grant.tenantId,
          grant.id,
          grant.policyId,
          grant.source,
          grant.sourceRef,
          grant.status,
          idempotencyKey,
          payloadHash,
          JSON.stringify(grant),
        )
        .run();
      return { kind: "created", grant };
    } catch (error) {
      const racedIssuance = await this.#grantByIssuance(grant.tenantId, idempotencyKey);
      if (racedIssuance !== null) return grantReplay(racedIssuance, payloadHash);
      if ((await this.#grantBySource(grant)) !== null) return { kind: "conflict" };
      throw error;
    }
  }

  async getEntitlementGrant(
    tenantId: TenantId,
    grantId: EntitlementGrantId,
  ): Promise<EntitlementGrant | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_entitlement_grants WHERE tenant_id = ? AND grant_id = ?")
      .bind(tenantId, grantId)
      .first<{ value: string }>();
    return row === null ? undefined : decodeEntitlementGrant(row.value);
  }

  async transitionEntitlementGrant(
    input: Parameters<EntitlementStore["transitionEntitlementGrant"]>[0],
  ): Promise<TransitionEntitlementGrantResult> {
    if (input.expectedStatuses.length === 0) return { kind: "invalid_transition" };
    const payload = `${input.grantId}:${input.status}`;
    const replay = await this.#transition(input.tenantId, input.idempotencyKey);
    if (replay !== null) return transitionReplay(replay, payload);
    const current = await this.getEntitlementGrant(input.tenantId, input.grantId);
    if (current === undefined) return { kind: "not_found" };
    if (!input.expectedStatuses.includes(current.status)) return { kind: "invalid_transition" };
    const updated: EntitlementGrant = {
      ...current,
      status: input.status,
      updatedAt: input.updatedAt,
    };
    const placeholders = input.expectedStatuses.map(() => "?").join(", ");
    try {
      const results = await this.#writes.execute(
        [
          this.#db
            .prepare(
              `UPDATE polybill_entitlement_grants SET status = ?, value = ?, update_token = ? WHERE tenant_id = ? AND grant_id = ? AND status IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM polybill_entitlement_transitions WHERE tenant_id = ? AND idempotency_key = ?)`,
            )
            .bind(
              input.status,
              JSON.stringify(updated),
              input.idempotencyKey,
              input.tenantId,
              input.grantId,
              ...input.expectedStatuses,
              input.tenantId,
              input.idempotencyKey,
            ),
          this.#db
            .prepare(
              "INSERT INTO polybill_entitlement_transitions (tenant_id, idempotency_key, grant_id, payload, value) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM polybill_entitlement_grants WHERE tenant_id = ? AND grant_id = ? AND update_token = ?)",
            )
            .bind(
              input.tenantId,
              input.idempotencyKey,
              input.grantId,
              payload,
              JSON.stringify(updated),
              input.tenantId,
              input.grantId,
              input.idempotencyKey,
            ),
        ],
        "entitlement.transition",
      );
      if (changes(results[0]) === 1 && changes(results[1]) === 1)
        return { kind: "changed", grant: updated };
    } catch (error) {
      const raced = await this.#transition(input.tenantId, input.idempotencyKey);
      if (raced === null) throw error;
      return transitionReplay(raced, payload);
    }
    const raced = await this.#transition(input.tenantId, input.idempotencyKey);
    if (raced !== null) return transitionReplay(raced, payload);
    const observed = await this.getEntitlementGrant(input.tenantId, input.grantId);
    return observed === undefined ? { kind: "not_found" } : { kind: "invalid_transition" };
  }

  #policyByIssuance(tenantId: TenantId, idempotencyKey: string) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_entitlement_policies WHERE tenant_id = ? AND issuance_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ payload_hash: string; value: string }>();
  }

  #grantByIssuance(tenantId: TenantId, idempotencyKey: string) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_entitlement_grants WHERE tenant_id = ? AND issuance_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ payload_hash: string; value: string }>();
  }

  #grantBySource(grant: EntitlementGrant) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_entitlement_grants WHERE tenant_id = ? AND policy_id = ? AND source = ? AND source_ref = ?",
      )
      .bind(grant.tenantId, grant.policyId, grant.source, grant.sourceRef)
      .first<{ payload_hash: string; value: string }>();
  }

  #transition(tenantId: TenantId, idempotencyKey: string) {
    return this.#db
      .prepare(
        "SELECT payload, value FROM polybill_entitlement_transitions WHERE tenant_id = ? AND idempotency_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ payload: string; value: string }>();
  }
}

function policyReplay(
  row: { payload_hash: string; value: string },
  payloadHash: string,
): CreateEntitlementPolicyResult {
  return row.payload_hash === payloadHash
    ? { kind: "replay", policy: decodeEntitlementPolicy(row.value) }
    : { kind: "conflict" };
}

function grantReplay(
  row: { payload_hash: string; value: string },
  payloadHash: string,
): CreateEntitlementGrantResult {
  return row.payload_hash === payloadHash
    ? { kind: "replay", grant: decodeEntitlementGrant(row.value) }
    : { kind: "conflict" };
}

function transitionReplay(
  row: { payload: string; value: string },
  payload: string,
): TransitionEntitlementGrantResult {
  return row.payload === payload
    ? { kind: "replay", grant: decodeEntitlementGrant(row.value) }
    : { kind: "conflict" };
}

function changes(
  result: { readonly meta?: Readonly<Record<string, unknown>> } | undefined,
): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}
