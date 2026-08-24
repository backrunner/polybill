import type {
  ApplicationStore,
  CheckoutCommit,
  IdempotencyClaim,
  IdempotencyScope,
  ResourceCommit,
  ReconciliationTarget,
} from "@polybill/application";
import type { CheckoutSession, Price, TenantId } from "@polybill/core";

interface IdempotencyRecord {
  readonly payloadHash: string;
  readonly leaseToken: string;
  state: "claimed" | "complete" | "unknown";
  result?: unknown;
  recoveryContext?: unknown;
  evidence?: string;
}

export class MemoryStore implements ApplicationStore {
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #prices = new Map<string, Price>();
  readonly #checkouts = new Map<string, CheckoutSession>();
  readonly #mappings = new Map<string, string>();
  readonly #reverseMappings = new Map<string, string>();
  readonly #mappingRecords = new Map<string, ReconciliationTarget>();
  readonly #reconciliationCheckpoints = new Map<string, { cursor?: string; sequence: number }>();
  readonly #resources = new Map<string, unknown>();
  readonly #commits: CheckoutCommit[] = [];
  #leaseSequence = 0;

  seedPrice(tenantId: TenantId, price: Price): void {
    this.#prices.set(`${tenantId}:${price.id}`, globalThis.structuredClone(price));
  }

  seedMapping(
    tenantId: TenantId,
    connectionId: string,
    entityType: string,
    entityId: string,
    externalId: string,
  ): void {
    this.#mappings.set(`${tenantId}:${connectionId}:${entityType}:${entityId}`, externalId);
    this.#reverseMappings.set(`${tenantId}:${connectionId}:${entityType}:${externalId}`, entityId);
    if (entityType === "customer" || entityType === "subscription" || entityType === "refund")
      this.#mappingRecords.set(`${tenantId}:${connectionId}:${entityType}:${entityId}`, {
        entityType,
        entityId,
        externalId,
      });
  }

  get commits(): readonly CheckoutCommit[] {
    return this.#commits.map((commit) => globalThis.structuredClone(commit));
  }

  async claim(scope: IdempotencyScope, payloadHash: string): Promise<IdempotencyClaim> {
    const key = scopeKey(scope);
    const current = this.#idempotency.get(key);
    if (current !== undefined) {
      if (current.payloadHash !== payloadHash) return { kind: "conflict" };
      if (current.state === "complete")
        return { kind: "replay", result: globalThis.structuredClone(current.result) };
      if (current.state === "unknown") {
        return {
          kind: "outcome_unknown",
          leaseToken: current.leaseToken,
          recoveryContext: globalThis.structuredClone(current.recoveryContext),
          ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
        };
      }
      return { kind: "in_progress" };
    }
    const leaseToken = `lease_${String(++this.#leaseSequence).padStart(8, "0")}`;
    this.#idempotency.set(key, { payloadHash, leaseToken, state: "claimed" });
    return { kind: "claimed", leaseToken };
  }

  async complete(scope: IdempotencyScope, leaseToken: string, result: unknown): Promise<void> {
    const record = this.#owned(scope, leaseToken);
    record.state = "complete";
    record.result = globalThis.structuredClone(result);
  }

  async saveRecoveryContext(
    scope: IdempotencyScope,
    leaseToken: string,
    recoveryContext: unknown,
  ): Promise<void> {
    const record = this.#owned(scope, leaseToken);
    record.recoveryContext = globalThis.structuredClone(recoveryContext);
  }

  async markUnknown(scope: IdempotencyScope, leaseToken: string, evidence?: string): Promise<void> {
    const record = this.#owned(scope, leaseToken);
    record.state = "unknown";
    if (evidence !== undefined) record.evidence = evidence;
  }

  async release(scope: IdempotencyScope, leaseToken: string): Promise<void> {
    this.#owned(scope, leaseToken);
    this.#idempotency.delete(scopeKey(scope));
  }

  async getPrice(tenantId: TenantId, priceId: string): Promise<Price | undefined> {
    const seeded = this.#prices.get(`${tenantId}:${priceId}`);
    return seeded === undefined
      ? this.getResource<Price>(tenantId, "price", priceId)
      : globalThis.structuredClone(seeded);
  }

  async getExternalId(
    tenantId: TenantId,
    connectionId: string,
    entityType: string,
    entityId: string,
  ): Promise<string | undefined> {
    return this.#mappings.get(`${tenantId}:${connectionId}:${entityType}:${entityId}`);
  }

  async findCanonicalId(
    tenantId: TenantId,
    connectionId: string,
    entityType: string,
    externalId: string,
  ): Promise<string | undefined> {
    return this.#reverseMappings.get(`${tenantId}:${connectionId}:${entityType}:${externalId}`);
  }

  async commitResource(commit: ResourceCommit): Promise<void> {
    const key = `${commit.tenantId}:${commit.entityType}:${commit.entityId}`;
    this.#resources.set(key, globalThis.structuredClone(commit.value));
    if (commit.externalId !== undefined)
      this.seedMapping(
        commit.tenantId,
        commit.connectionId,
        commit.entityType,
        commit.entityId,
        commit.externalId,
      );
  }

  async listReconciliationTargets(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly after?: string;
    readonly limit: number;
  }) {
    const prefix = `${input.tenantId}:${input.connectionId}:`;
    const values = [...this.#mappingRecords.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value)
      .sort((left, right) => cursor(left).localeCompare(cursor(right)))
      .filter((value) => input.after === undefined || cursor(value) > input.after)
      .slice(0, input.limit);
    const last = values.at(-1);
    const nextCursor = last === undefined ? undefined : cursor(last);
    return {
      items: globalThis.structuredClone(values),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async getReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly stream: string;
  }) {
    const value = this.#reconciliationCheckpoints.get(
      `${input.tenantId}:${input.connectionId}:${input.stream}`,
    );
    return value === undefined ? undefined : globalThis.structuredClone(value);
  }

  async saveReconciliationCheckpoint(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly stream: string;
    readonly cursor?: string;
    readonly sequence: number;
  }): Promise<void> {
    const key = `${input.tenantId}:${input.connectionId}:${input.stream}`;
    const current = this.#reconciliationCheckpoints.get(key);
    if (current === undefined || input.sequence >= current.sequence)
      this.#reconciliationCheckpoints.set(key, {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        sequence: input.sequence,
      });
  }

  async getResource<T>(
    tenantId: TenantId,
    entityType: string,
    entityId: string,
  ): Promise<T | undefined> {
    const value = this.#resources.get(`${tenantId}:${entityType}:${entityId}`);
    return value === undefined ? undefined : (globalThis.structuredClone(value) as T);
  }

  async commitCheckout(commit: CheckoutCommit): Promise<void> {
    const checkoutKey = `${commit.tenantId}:${commit.checkout.id}`;
    const mappingKey = `${commit.connectionId}:${commit.externalCheckoutId}`;
    if (this.#checkouts.has(checkoutKey)) throw new Error("Checkout already exists");
    if (
      this.#commits.some((item) => `${item.connectionId}:${item.externalCheckoutId}` === mappingKey)
    ) {
      throw new Error("External checkout mapping already exists");
    }
    this.#checkouts.set(checkoutKey, globalThis.structuredClone(commit.checkout));
    this.#resources.set(
      `${commit.tenantId}:order:${commit.order.id}`,
      globalThis.structuredClone(commit.order),
    );
    this.#resources.set(
      `${commit.tenantId}:payment:${commit.payment.id}`,
      globalThis.structuredClone(commit.payment),
    );
    this.#commits.push(globalThis.structuredClone(commit));
  }

  async getCheckout(tenantId: TenantId, checkoutId: string): Promise<CheckoutSession | undefined> {
    const value = this.#checkouts.get(`${tenantId}:${checkoutId}`);
    return value === undefined ? undefined : globalThis.structuredClone(value);
  }

  #owned(scope: IdempotencyScope, leaseToken: string): IdempotencyRecord {
    const record = this.#idempotency.get(scopeKey(scope));
    if (record === undefined || record.leaseToken !== leaseToken)
      throw new Error("Idempotency lease lost");
    return record;
  }
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}

function scopeKey(scope: IdempotencyScope): string {
  return `${scope.tenantId}:${scope.connectionId}:${scope.operation}:${scope.key}`;
}

function cursor(target: ReconciliationTarget): string {
  return `${target.entityType}:${target.entityId}`;
}
