import type { ProviderProductSnapshot } from "@polybill/adapter-kit";
import {
  PolybillError,
  parseId,
  type IdempotencyKey,
  type Price,
  type PriceId,
  type PriceModel,
  type Product,
  type ProductId,
  type Sku,
  type SkuId,
} from "@polybill/core";
import { requireExternalId } from "./resource-runtime.js";
import type { ResourceRuntime } from "./resource-runtime.js";

export interface CreateProductCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly name: string;
  readonly description?: string;
  readonly media?: readonly string[];
  readonly taxCategory?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateSkuCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly productId: ProductId;
  readonly key: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly fulfillment: "digital" | "service";
  readonly taxCategory?: string;
  readonly entitlementPolicyIds?: Sku["entitlementPolicyIds"];
}

export interface CreatePriceCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly skuId: SkuId;
  readonly model: PriceModel;
  readonly taxBehavior: Price["taxBehavior"];
  readonly metadata?: Readonly<Record<string, string>>;
}

export class CatalogService {
  readonly #runtime: ResourceRuntime;

  constructor(runtime: ResourceRuntime) {
    this.#runtime = runtime;
  }

  async createProduct(command: CreateProductCommand): Promise<Product> {
    text(command.name, "product name");
    return this.#runtime.mutate({
      operation: "catalog.product.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeProduct,
      execute: async (context) => {
        await this.#runtime.requireCapability("catalog.product.create", context);
        const port = this.#runtime.options.adapter.catalog;
        if (port === undefined) throw unsupported("catalog.product.create");
        const remote = await port.createProduct(context, {
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
          metadata: command.metadata ?? {},
        });
        const product = canonicalProduct(
          parseId<"ProductId">(this.#runtime.options.ids.next("prod"), "prod"),
          command,
          remote.value,
        );
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "product", product.id, remote.value.externalId),
          value: product,
          evidence: remote.evidence,
        });
        return product;
      },
    });
  }

  async createSku(command: CreateSkuCommand): Promise<Sku> {
    text(command.key, "SKU key");
    if ((await this.getProduct(command.productId)) === undefined)
      throw notFound("catalog.sku.create");
    return this.#runtime.mutate({
      operation: "catalog.sku.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodeSku,
      execute: async () => {
        const sku: Sku = {
          id: parseId<"SkuId">(this.#runtime.options.ids.next("sku"), "sku"),
          productId: command.productId,
          key: command.key,
          attributes: command.attributes ?? {},
          fulfillment: command.fulfillment,
          ...(command.taxCategory === undefined ? {} : { taxCategory: command.taxCategory }),
          entitlementPolicyIds: command.entitlementPolicyIds ?? [],
          status: "active",
          version: 1,
        };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "sku", sku.id),
          value: sku,
        });
        return sku;
      },
    });
  }

  async createPrice(command: CreatePriceCommand): Promise<Price> {
    const sku = await this.getSku(command.skuId);
    if (sku === undefined) throw notFound("catalog.price.create");
    return this.#runtime.mutate({
      operation: "catalog.price.create",
      key: command.idempotencyKey,
      payload: command,
      decodeReplay: decodePrice,
      execute: async (context) => {
        await this.#runtime.requireCapability("catalog.price.create", context);
        const port = this.#runtime.options.adapter.catalog;
        if (port === undefined) throw unsupported("catalog.price.create");
        const externalProductId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "product",
            sku.productId,
          ),
          "catalog.price.create",
        );
        const remote = await port.createPrice(context, {
          externalProductId,
          model: command.model,
          taxBehavior: command.taxBehavior,
          metadata: command.metadata ?? {},
        });
        const price: Price = {
          id: parseId<"PriceId">(this.#runtime.options.ids.next("price"), "price"),
          skuId: command.skuId,
          version: 1,
          model: command.model,
          taxBehavior: command.taxBehavior,
          status: "active",
          metadata: command.metadata ?? {},
        };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "price", price.id, remote.value.externalId),
          value: price,
          evidence: remote.evidence,
        });
        return price;
      },
    });
  }

  getProduct(id: ProductId): Promise<Product | undefined> {
    return this.#runtime.options.store.getResource(this.#runtime.options.tenantId, "product", id);
  }

  getSku(id: SkuId): Promise<Sku | undefined> {
    return this.#runtime.options.store.getResource(this.#runtime.options.tenantId, "sku", id);
  }

  getPrice(id: PriceId): Promise<Price | undefined> {
    return this.#runtime.options.store.getResource(this.#runtime.options.tenantId, "price", id);
  }
}

function canonicalProduct(
  id: ProductId,
  command: CreateProductCommand,
  remote: ProviderProductSnapshot,
): Product {
  return {
    id,
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    media: command.media ?? [],
    ...(command.taxCategory === undefined ? {} : { taxCategory: command.taxCategory }),
    metadata: command.metadata ?? {},
    status: remote.status === "archived" ? "archived" : "active",
    version: 1,
  };
}

function commitBase(
  runtime: ResourceRuntime,
  entityType: string,
  entityId: string,
  externalId?: string,
) {
  return {
    tenantId: runtime.options.tenantId,
    connectionId: runtime.options.connection.id,
    provider: runtime.options.connection.provider,
    entityType,
    entityId,
    ...(externalId === undefined ? {} : { externalId }),
    occurredAt: runtime.options.clock.now(),
  };
}

function decodeProduct(value: unknown): Product {
  return decodeResource<Product>(value, "id", "product");
}
function decodeSku(value: unknown): Sku {
  return decodeResource<Sku>(value, "id", "SKU");
}
function decodePrice(value: unknown): Price {
  return decodeResource<Price>(value, "id", "price");
}
function decodeResource<T>(value: unknown, key: string, name: string): T {
  if (typeof value !== "object" || value === null || !(key in value))
    throw new TypeError(`Stored ${name} replay is invalid`);
  return value as T;
}
function text(value: string, name: string): void {
  if (value.length < 1 || value.length > 255) throw new TypeError(`Invalid ${name}`);
}
function unsupported(operation: string): PolybillError {
  return new PolybillError("Provider resource port is unavailable", {
    code: "unsupported_capability",
    operation,
    retryable: false,
  });
}
function notFound(operation: string): PolybillError {
  return new PolybillError("Canonical catalog resource was not found", {
    code: "not_found",
    operation,
    retryable: false,
  });
}
