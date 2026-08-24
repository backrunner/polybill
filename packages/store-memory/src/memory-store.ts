import type {
  ApplicationStore,
  CheckoutCommit,
  IdempotencyClaim,
  IdempotencyScope,
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
  readonly #commits: CheckoutCommit[] = [];
  #leaseSequence = 0;

  seedPrice(tenantId: TenantId, price: Price): void {
    this.#prices.set(`${tenantId}:${price.id}`, globalThis.structuredClone(price));
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
    const value = this.#prices.get(`${tenantId}:${priceId}`);
    return value === undefined ? undefined : globalThis.structuredClone(value);
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
