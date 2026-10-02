import {
  PolybillError,
  parseId,
  parseIdempotencyKey,
  type CustomerId,
  type IdempotencyKey,
} from "@polybill/core";
import type { BillingScope, BillingStore, CreditEntry } from "./billing-store.js";
import type { ResourceRuntime } from "./resource-runtime.js";
import { stableStringify } from "./checkout-helpers.js";

export class CreditService {
  constructor(
    readonly runtime: ResourceRuntime,
    readonly store: BillingStore,
  ) {}

  async balance(customerId: CustomerId, unit: string) {
    await this.#validate(customerId, unit);
    return this.store.getCreditBalance(this.#scope(), customerId, unit);
  }

  async adjust(command: {
    readonly customerId: CustomerId;
    readonly unit: string;
    readonly delta: string;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<CreditEntry> {
    await this.#validate(command.customerId, command.unit);
    parseIdempotencyKey(command.idempotencyKey);
    if (typeof command.delta !== "string" || !/^-?[1-9][0-9]{0,77}$/.test(command.delta))
      throw new TypeError("Credit delta must be a nonzero integer string");
    const scope = this.#scope();
    const id = await this.#hash(command.idempotencyKey);
    const payloadHash = await this.#hash(stableStringify(command));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const existing = await this.store.getCreditEntry(scope, id);
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) throw failure("idempotency_conflict");
        return existing;
      }
      const current = await this.store.getCreditBalance(scope, command.customerId, command.unit);
      const balance = BigInt(current.balance) + BigInt(command.delta);
      if (balance < 0n) {
        const completed = await this.store.getCreditEntry(scope, id);
        if (completed !== undefined) {
          if (completed.payloadHash !== payloadHash) throw failure("idempotency_conflict");
          return completed;
        }
        throw failure("invalid_request");
      }
      const entry: CreditEntry = {
        id,
        customerId: command.customerId,
        unit: command.unit,
        delta: command.delta,
        balance: String(balance),
        revision: current.revision + 1,
        payloadHash,
        occurredAt: this.runtime.options.clock.now(),
      };
      if (await this.store.appendCreditEntry(scope, entry, current.revision)) return entry;
    }
    throw failure("conflict");
  }

  #scope(): BillingScope {
    const { tenantId, connection } = this.runtime.options;
    return { tenantId, connectionId: connection.id, environment: connection.environment };
  }
  #hash(value: string) {
    return this.runtime.options.crypto.sha256(new TextEncoder().encode(value));
  }
  async #validate(customerId: CustomerId, unit: string) {
    parseId<"CustomerId">(customerId, "cust");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(unit)) throw new TypeError("Invalid credit unit");
    await this.runtime.options.store.bindConnection(this.runtime.options.connection);
    if (
      (await this.runtime.options.store.getResource(
        this.runtime.options.tenantId,
        "customer",
        customerId,
      )) === undefined
    )
      throw failure("not_found");
  }
}

function failure(code: "idempotency_conflict" | "invalid_request" | "conflict" | "not_found") {
  return new PolybillError(
    code === "invalid_request"
      ? "Insufficient credit balance"
      : "Credit operation could not be applied",
    {
      code,
      operation: "credit.adjust",
      retryable: code === "conflict",
    },
  );
}
