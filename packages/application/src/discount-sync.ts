import type { ProviderDiscountSnapshot } from "@polybill/adapter-kit";
import {
  PolybillError,
  type Discount,
  type DiscountId,
  type IdempotencyKey,
  type ProductId,
} from "@polybill/core";
import { stableStringify } from "./checkout-helpers.js";
import { requireExternalId, type ResourceRuntime } from "./resource-runtime.js";

export interface DiscountSyncReport {
  readonly discountId: DiscountId;
  readonly status: "matched" | "different" | "missing_remote" | "published";
  readonly differences: readonly {
    readonly field: string;
    readonly local: unknown;
    readonly remote: unknown;
  }[];
}

export class DiscountSyncService {
  readonly #runtime: ResourceRuntime;

  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async diff(id: DiscountId): Promise<DiscountSyncReport> {
    const local = await this.#discount(id);
    const externalId = await this.#external(id);
    if (externalId === undefined) return report(id, "missing_remote", []);
    const context = await this.#runtime.context();
    await this.#runtime.requireCapability("discount.read", context);
    const get = this.#runtime.options.adapter.discounts?.get;
    if (get === undefined) throw unsupported("discount.read");
    const remote = (await get(context, externalId)).value;
    const expectedProducts = await this.#externalProducts(local);
    return report(id, "different", differences(local, expectedProducts, remote));
  }

  push(id: DiscountId, idempotencyKey: IdempotencyKey): Promise<DiscountSyncReport> {
    return this.#runtime.mutate({
      operation: "discount.sync.push",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeReport,
      execute: async (context) => {
        const local = await this.#discount(id);
        if (local.status !== "active") throw invalid("Archived discounts cannot be published");
        if ((await this.#external(id)) !== undefined) return this.diff(id);
        await this.#runtime.requireCapability("discount.create", context);
        const create = this.#runtime.options.adapter.discounts?.create;
        if (create === undefined) throw unsupported("discount.create");
        const remote = await create(context, {
          discount: local,
          externalProductIds: await this.#externalProducts(local),
        });
        await this.#runtime.options.store.commitResource({
          tenantId: this.#runtime.options.tenantId,
          connectionId: this.#runtime.options.connection.id,
          provider: this.#runtime.options.connection.provider,
          entityType: "discount",
          entityId: id,
          externalId: remote.value.externalId,
          value: local,
          evidence: remote.evidence,
          occurredAt: this.#runtime.options.clock.now(),
        });
        return report(id, "published", []);
      },
    });
  }

  async #discount(id: DiscountId): Promise<Discount> {
    const value = await this.#runtime.options.store.getDiscount(this.#runtime.options.tenantId, id);
    if (value === undefined)
      throw new PolybillError("Canonical discount was not found", {
        code: "not_found",
        operation: "discount.sync",
        retryable: false,
      });
    return value;
  }

  #external(id: DiscountId): Promise<string | undefined> {
    return this.#runtime.options.store.getExternalId(
      this.#runtime.options.tenantId,
      this.#runtime.options.connection.id,
      "discount",
      id,
    );
  }

  async #externalProducts(discount: Discount): Promise<readonly string[]> {
    const values = await Promise.all(
      discount.eligibleSkuIds.map(async (skuId) => {
        const sku = await this.#runtime.options.store.getResource<{
          readonly productId: ProductId;
        }>(this.#runtime.options.tenantId, "sku", skuId);
        if (sku === undefined) throw invalid("Eligible discount SKU was not found");
        return requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "product",
            sku.productId,
          ),
          "discount.sync.resolve_product",
        );
      }),
    );
    return [...new Set(values)].sort();
  }
}

function differences(
  local: Discount,
  externalProductIds: readonly string[],
  remote: ProviderDiscountSnapshot,
) {
  const pairs = [
    ["value", local.value, remote.value],
    ["status", local.status === "active" ? "active" : "unavailable", remote.status],
    ["externalProductIds", externalProductIds, [...remote.externalProductIds].sort()],
    ["maxRedemptions", local.maxRedemptions, remote.maxRedemptions],
    ["expiresAt", local.expiresAt, remote.expiresAt],
  ] as const;
  return pairs.flatMap(([field, expected, actual]) =>
    stableStringify(expected) === stableStringify(actual)
      ? []
      : [{ field, local: expected, remote: actual }],
  );
}

function report(
  discountId: DiscountId,
  status: DiscountSyncReport["status"],
  values: DiscountSyncReport["differences"],
): DiscountSyncReport {
  return {
    discountId,
    status: status === "different" && values.length === 0 ? "matched" : status,
    differences: values,
  };
}

function decodeReport(value: unknown): DiscountSyncReport {
  if (!record(value) || typeof value.discountId !== "string" || typeof value.status !== "string")
    throw new TypeError("Stored discount sync report is invalid");
  return value as unknown as DiscountSyncReport;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(operation: string): PolybillError {
  return new PolybillError("Provider discount sync capability is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}

function invalid(message: string): PolybillError {
  return new PolybillError(message, {
    code: "invalid_request",
    operation: "discount.sync",
    retryable: false,
  });
}
