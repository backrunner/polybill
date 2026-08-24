import type { MigrationItemClaim, MigrationStore } from "./ports.js";
import type { AdoptionMode, MigrationItemResult, MigrationPlan } from "./types.js";

export class MemoryMigrationStore implements MigrationStore {
  readonly #plans = new Map<string, MigrationPlan>();
  readonly #states = new Map<
    string,
    { state: "processing" | "completed" | "failed"; leaseToken?: string; leaseExpiresAt?: number }
  >();
  readonly #results = new Map<string, MigrationItemResult>();
  readonly #checkpoints = new Map<string, { cursor?: string; sequence: number }>();
  readonly #now: () => number;
  readonly #leaseToken: () => string;
  readonly #leaseMs: number;
  #routing: { mode: AdoptionMode; planId: string } | undefined;

  constructor(
    options: {
      readonly now?: () => number;
      readonly leaseToken?: () => string;
      readonly leaseMs?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#leaseToken = options.leaseToken ?? (() => globalThis.crypto.randomUUID());
    this.#leaseMs = options.leaseMs ?? 60_000;
  }

  async savePlan(plan: MigrationPlan): Promise<void> {
    this.#plans.set(plan.id, clone(plan));
  }
  async getPlan(planId: string): Promise<MigrationPlan | undefined> {
    return cloned(this.#plans.get(planId));
  }
  async claimItem(planId: string, itemKey: string): Promise<MigrationItemClaim> {
    const key = `${planId}:${itemKey}`;
    const existing = this.#states.get(key);
    if (existing?.state === "completed") return { kind: "completed" };
    if (
      existing?.state === "processing" &&
      existing.leaseExpiresAt !== undefined &&
      existing.leaseExpiresAt > this.#now()
    )
      return { kind: "in_progress" };
    const leaseToken = this.#leaseToken();
    this.#states.set(key, {
      state: "processing",
      leaseToken,
      leaseExpiresAt: this.#now() + this.#leaseMs,
    });
    return { kind: "claimed", leaseToken };
  }
  async completeItem(
    planId: string,
    leaseToken: string,
    result: MigrationItemResult,
  ): Promise<void> {
    const key = `${planId}:${result.itemKey}`;
    this.#assertLease(key, leaseToken);
    this.#states.set(key, { state: "completed" });
    this.#results.set(key, clone(result));
  }
  async failItem(
    planId: string,
    itemKey: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<void> {
    const key = `${planId}:${itemKey}`;
    this.#assertLease(key, leaseToken);
    this.#states.set(key, { state: "failed" });
    this.#results.set(key, { itemKey, status: "failed", errorCode });
  }
  async listResults(planId: string): Promise<readonly MigrationItemResult[]> {
    return [...this.#results.entries()]
      .filter(([key]) => key.startsWith(`${planId}:`))
      .map(([, value]) => clone(value))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
  }
  async saveCheckpoint(
    planId: string,
    stream: string,
    cursor: string | undefined,
    sequence: number,
  ): Promise<void> {
    this.#checkpoints.set(`${planId}:${stream}`, {
      ...(cursor === undefined ? {} : { cursor }),
      sequence,
    });
  }
  async getCheckpoint(planId: string, stream: string) {
    return cloned(this.#checkpoints.get(`${planId}:${stream}`));
  }
  async setRouting(mode: AdoptionMode, planId: string): Promise<void> {
    this.#routing = { mode, planId };
  }
  async getRouting() {
    return cloned(this.#routing);
  }

  #assertLease(key: string, leaseToken: string): void {
    const state = this.#states.get(key);
    if (state?.state !== "processing" || state.leaseToken !== leaseToken)
      throw new Error("Migration item lease is not owned by this runner");
  }
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
function cloned<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
