import type { ProviderPriceSnapshot, ProviderProductSnapshot } from "@polybill/adapter-kit";
import {
  PolybillError,
  type IdempotencyKey,
  type Price,
  type PriceId,
  type Product,
  type ProductId,
} from "@polybill/core";
import { stableStringify } from "./checkout-helpers.js";
import { requireExternalId, type ResourceRuntime } from "./resource-runtime.js";

export interface CatalogSyncDifference {
  readonly field: string;
  readonly local: unknown;
  readonly remote: unknown;
}

export interface CatalogSyncReport {
  readonly entityType: "product" | "price";
  readonly entityId: string;
  readonly status: "matched" | "different" | "missing_remote" | "published" | "pulled";
  readonly differences: readonly CatalogSyncDifference[];
}

export class CatalogSyncService {
  readonly #runtime: ResourceRuntime;

  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async diffProduct(id: ProductId): Promise<CatalogSyncReport> {
    const local = await this.#product(id);
    const externalId = await this.#external("product", id);
    if (externalId === undefined) return report("product", id, "missing_remote", []);
    const context = await this.#runtime.context();
    await this.#runtime.requireCapability("catalog.product.read", context);
    const get = this.#runtime.options.adapter.catalog?.getProduct;
    if (get === undefined) throw unsupported("catalog.product.read");
    return report(
      "product",
      id,
      "different",
      productDifferences(local, (await get(context, externalId)).value),
    );
  }

  async diffPrice(id: PriceId): Promise<CatalogSyncReport> {
    const local = await this.#price(id);
    const externalId = await this.#external("price", id);
    if (externalId === undefined) return report("price", id, "missing_remote", []);
    const context = await this.#runtime.context();
    await this.#runtime.requireCapability("catalog.price.read", context);
    const get = this.#runtime.options.adapter.catalog?.getPrice;
    if (get === undefined) throw unsupported("catalog.price.read");
    return report(
      "price",
      id,
      "different",
      priceDifferences(local, (await get(context, externalId)).value),
    );
  }

  pushProduct(id: ProductId, idempotencyKey: IdempotencyKey): Promise<CatalogSyncReport> {
    return this.#runtime.mutate({
      operation: "catalog.sync.product.push",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeReport,
      execute: async (context) => {
        const local = await this.#product(id);
        const existing = await this.#external("product", id);
        if (existing !== undefined) return this.diffProduct(id);
        await this.#runtime.requireCapability("catalog.product.create", context);
        const create = this.#runtime.options.adapter.catalog?.createProduct;
        if (create === undefined) throw unsupported("catalog.product.create");
        const remote = await create(context, {
          name: local.name,
          ...(local.description === undefined ? {} : { description: local.description }),
          metadata: local.metadata,
        });
        await this.#commit("product", id, local, remote.value.externalId, remote.evidence);
        return report("product", id, "published", []);
      },
    });
  }

  pushPrice(id: PriceId, idempotencyKey: IdempotencyKey): Promise<CatalogSyncReport> {
    return this.#runtime.mutate({
      operation: "catalog.sync.price.push",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeReport,
      execute: async (context) => {
        const local = await this.#price(id);
        const existing = await this.#external("price", id);
        if (existing !== undefined) return this.diffPrice(id);
        const sku = await this.#runtime.options.store.getResource<{
          readonly productId: ProductId;
        }>(this.#runtime.options.tenantId, "sku", local.skuId);
        if (sku === undefined) throw notFound("catalog.sync.price.push");
        const externalProductId = requireExternalId(
          await this.#external("product", sku.productId),
          "catalog.sync.price.push",
        );
        await this.#runtime.requireCapability("catalog.price.create", context);
        const create = this.#runtime.options.adapter.catalog?.createPrice;
        if (create === undefined) throw unsupported("catalog.price.create");
        const remote = await create(context, {
          externalProductId,
          model: local.model,
          taxBehavior: local.taxBehavior,
          metadata: local.metadata,
        });
        await this.#commit("price", id, local, remote.value.externalId, remote.evidence);
        return report("price", id, "published", []);
      },
    });
  }

  pullProduct(id: ProductId, idempotencyKey: IdempotencyKey): Promise<CatalogSyncReport> {
    return this.#runtime.mutate({
      operation: "catalog.sync.product.pull",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeReport,
      execute: async (context) => {
        const local = await this.#product(id);
        const externalId = requireExternalId(
          await this.#external("product", id),
          "catalog.sync.product.pull",
        );
        await this.#runtime.requireCapability("catalog.product.read", context);
        const get = this.#runtime.options.adapter.catalog?.getProduct;
        if (get === undefined) throw unsupported("catalog.product.read");
        const remote = await get(context, externalId);
        if (remote.value.status === "unknown") throw invalidRemote("catalog.sync.product.pull");
        const updated: Product = {
          ...local,
          name: remote.value.name,
          ...(remote.value.description === undefined
            ? {}
            : { description: remote.value.description }),
          status: remote.value.status,
          version: local.version + 1,
        };
        await this.#commit("product", id, updated, externalId, remote.evidence);
        return report("product", id, "pulled", productDifferences(updated, remote.value));
      },
    });
  }

  async #product(id: ProductId): Promise<Product> {
    const value = await this.#runtime.options.store.getResource<Product>(
      this.#runtime.options.tenantId,
      "product",
      id,
    );
    if (value === undefined) throw notFound("catalog.sync.product");
    return value;
  }

  async #price(id: PriceId): Promise<Price> {
    const value = await this.#runtime.options.store.getResource<Price>(
      this.#runtime.options.tenantId,
      "price",
      id,
    );
    if (value === undefined) throw notFound("catalog.sync.price");
    return value;
  }

  #external(type: string, id: string): Promise<string | undefined> {
    return this.#runtime.options.store.getExternalId(
      this.#runtime.options.tenantId,
      this.#runtime.options.connection.id,
      type,
      id,
    );
  }

  async #commit(type: string, id: string, value: unknown, externalId: string, evidence: unknown) {
    await this.#runtime.options.store.commitResource({
      tenantId: this.#runtime.options.tenantId,
      connectionId: this.#runtime.options.connection.id,
      provider: this.#runtime.options.connection.provider,
      entityType: type,
      entityId: id,
      externalId,
      value,
      evidence,
      occurredAt: this.#runtime.options.clock.now(),
    });
  }
}

function productDifferences(local: Product, remote: ProviderProductSnapshot) {
  return differences(local, {
    name: remote.name,
    description: remote.description,
    status: remote.status,
  });
}

function priceDifferences(local: Price, remote: ProviderPriceSnapshot) {
  return differences(local, { model: remote.model, status: remote.status });
}

function differences(local: object, remote: Readonly<Record<string, unknown>>) {
  return Object.entries(remote).flatMap(([field, value]) => {
    const localValue = Reflect.get(local, field) as unknown;
    return value !== undefined && stableStringify(localValue) !== stableStringify(value)
      ? [{ field, local: localValue, remote: value }]
      : [];
  });
}

function report(
  entityType: CatalogSyncReport["entityType"],
  entityId: string,
  status: CatalogSyncReport["status"],
  values: readonly CatalogSyncDifference[],
): CatalogSyncReport {
  return {
    entityType,
    entityId,
    status: values.length === 0 && status === "different" ? "matched" : status,
    differences: values,
  };
}

function decodeReport(value: unknown): CatalogSyncReport {
  if (
    typeof value !== "object" ||
    value === null ||
    !("entityType" in value) ||
    !("status" in value)
  )
    throw new TypeError("Stored catalog sync report is invalid");
  return value as CatalogSyncReport;
}

function unsupported(operation: string) {
  return new PolybillError("Provider catalog sync capability is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}

function notFound(operation: string) {
  return new PolybillError("Canonical catalog resource was not found", {
    code: "not_found",
    operation,
    retryable: false,
  });
}

function invalidRemote(operation: string) {
  return new PolybillError("Provider returned an unknown catalog status", {
    code: "provider_response_invalid",
    operation,
    retryable: false,
  });
}
