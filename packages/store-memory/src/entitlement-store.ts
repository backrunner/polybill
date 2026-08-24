import type { EntitlementGrantId, EntitlementPolicyId, TenantId } from "@polybill/core";
import type {
  CreateEntitlementGrantResult,
  CreateEntitlementPolicyResult,
  EntitlementGrant,
  EntitlementPolicy,
  EntitlementStore,
  TransitionEntitlementGrantResult,
} from "@polybill/licensing";

interface Issuance<T> {
  readonly payloadHash: string;
  readonly value: T;
}

export class MemoryEntitlementStore implements EntitlementStore {
  readonly #policies = new Map<string, EntitlementPolicy>();
  readonly #policyIssuance = new Map<string, Issuance<EntitlementPolicy>>();
  readonly #grants = new Map<string, EntitlementGrant>();
  readonly #grantIssuance = new Map<string, Issuance<EntitlementGrant>>();
  readonly #grantSources = new Map<string, Issuance<EntitlementGrant>>();
  readonly #transitions = new Map<string, { payload: string; grant: EntitlementGrant }>();

  async createEntitlementPolicy(
    tenantId: TenantId,
    policy: EntitlementPolicy,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementPolicyResult> {
    const issuanceKey = `${tenantId}:${idempotencyKey}`;
    const existing = this.#policyIssuance.get(issuanceKey);
    if (existing !== undefined)
      return existing.payloadHash === payloadHash
        ? { kind: "replay", policy: clone(existing.value) }
        : { kind: "conflict" };
    this.#policies.set(`${tenantId}:${policy.id}`, clone(policy));
    this.#policyIssuance.set(issuanceKey, { payloadHash, value: clone(policy) });
    return { kind: "created", policy: clone(policy) };
  }

  async getEntitlementPolicy(
    tenantId: TenantId,
    policyId: EntitlementPolicyId,
  ): Promise<EntitlementPolicy | undefined> {
    const policy = this.#policies.get(`${tenantId}:${policyId}`);
    return policy === undefined ? undefined : clone(policy);
  }

  async createEntitlementGrant(
    grant: EntitlementGrant,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CreateEntitlementGrantResult> {
    if (!this.#policies.has(`${grant.tenantId}:${grant.policyId}`))
      return { kind: "policy_not_found" };
    const issuanceKey = `${grant.tenantId}:${idempotencyKey}`;
    const existingIssuance = this.#grantIssuance.get(issuanceKey);
    if (existingIssuance !== undefined)
      return existingIssuance.payloadHash === payloadHash
        ? { kind: "replay", grant: clone(existingIssuance.value) }
        : { kind: "conflict" };
    const sourceKey = source(grant);
    const existingSource = this.#grantSources.get(sourceKey);
    if (existingSource !== undefined) return { kind: "conflict" };
    this.#grants.set(`${grant.tenantId}:${grant.id}`, clone(grant));
    this.#grantIssuance.set(issuanceKey, { payloadHash, value: clone(grant) });
    this.#grantSources.set(sourceKey, { payloadHash, value: clone(grant) });
    return { kind: "created", grant: clone(grant) };
  }

  async getEntitlementGrant(
    tenantId: TenantId,
    grantId: EntitlementGrantId,
  ): Promise<EntitlementGrant | undefined> {
    const grant = this.#grants.get(`${tenantId}:${grantId}`);
    return grant === undefined ? undefined : clone(grant);
  }

  async transitionEntitlementGrant(
    input: Parameters<EntitlementStore["transitionEntitlementGrant"]>[0],
  ): Promise<TransitionEntitlementGrantResult> {
    const transitionKey = `${input.tenantId}:${input.idempotencyKey}`;
    const payload = `${input.grantId}:${input.status}`;
    const replay = this.#transitions.get(transitionKey);
    if (replay !== undefined)
      return replay.payload === payload
        ? { kind: "replay", grant: clone(replay.grant) }
        : { kind: "conflict" };
    const grantKey = `${input.tenantId}:${input.grantId}`;
    const grant = this.#grants.get(grantKey);
    if (grant === undefined) return { kind: "not_found" };
    if (!input.expectedStatuses.includes(grant.status)) return { kind: "invalid_transition" };
    const updated = { ...grant, status: input.status, updatedAt: input.updatedAt };
    this.#grants.set(grantKey, clone(updated));
    this.#transitions.set(transitionKey, { payload, grant: clone(updated) });
    return { kind: "changed", grant: clone(updated) };
  }
}

function source(grant: EntitlementGrant): string {
  return `${grant.tenantId}:${grant.policyId}:${grant.source}:${grant.sourceRef}`;
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
