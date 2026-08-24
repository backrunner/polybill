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

export interface UpdateProductCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly name?: string;
  readonly description?: string;
  readonly media?: readonly string[];
  readonly taxCategory?: string;
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
        const port = this.#runtime.options.adapter.catalog?.createProduct;
        if (port === undefined) throw unsupported("catalog.product.create");
        const remote = await port(context, {
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
        const port = this.#runtime.options.adapter.catalog?.createPrice;
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
        const remote = await port(context, {
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

  async updateProduct(id: ProductId, command: UpdateProductCommand): Promise<Product> {
    const current = await this.getProduct(id);
    if (current === undefined) throw notFound("catalog.product.update");
    if (command.name !== undefined) text(command.name, "product name");
    return this.#runtime.mutate({
      operation: "catalog.product.update",
      key: command.idempotencyKey,
      payload: { id, ...command },
      decodeReplay: decodeProduct,
      execute: async (context) => {
        await this.#runtime.requireCapability("catalog.product.update", context);
        const port = this.#runtime.options.adapter.catalog?.updateProduct;
        if (port === undefined) throw unsupported("catalog.product.update");
        const externalId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "product",
            id,
          ),
          "catalog.product.update",
        );
        const remote = await port(context, externalId, {
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.description === undefined ? {} : { description: command.description }),
          ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
        });
        const product: Product = {
          ...current,
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.description === undefined ? {} : { description: command.description }),
          ...(command.media === undefined ? {} : { media: command.media }),
          ...(command.taxCategory === undefined ? {} : { taxCategory: command.taxCategory }),
          ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
          status: remote.value.status === "archived" ? "archived" : current.status,
          version: current.version + 1,
        };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "product", id, externalId),
          value: product,
          evidence: remote.evidence,
        });
        return product;
      },
    });
  }

  async archiveProduct(id: ProductId, idempotencyKey: IdempotencyKey): Promise<Product> {
    const current = await this.getProduct(id);
    if (current === undefined) throw notFound("catalog.product.archive");
    return this.#runtime.mutate({
      operation: "catalog.product.archive",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeProduct,
      execute: async (context) => {
        await this.#runtime.requireCapability("catalog.product.archive", context);
        const port = this.#runtime.options.adapter.catalog?.archiveProduct;
        if (port === undefined) throw unsupported("catalog.product.archive");
        const externalId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "product",
            id,
          ),
          "catalog.product.archive",
        );
        const remote = await port(context, externalId);
        const product: Product = { ...current, status: "archived", version: current.version + 1 };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "product", id, externalId),
          value: product,
          evidence: remote.evidence,
        });
        return product;
      },
    });
  }

  async archiveSku(id: SkuId, idempotencyKey: IdempotencyKey): Promise<Sku> {
    const current = await this.getSku(id);
    if (current === undefined) throw notFound("catalog.sku.archive");
    return this.#runtime.mutate({
      operation: "catalog.sku.archive",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodeSku,
      execute: async () => {
        const sku: Sku = { ...current, status: "archived", version: current.version + 1 };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "sku", id),
          value: sku,
        });
        return sku;
      },
    });
  }

  async retirePrice(id: PriceId, idempotencyKey: IdempotencyKey): Promise<Price> {
    const current = await this.getPrice(id);
    if (current === undefined) throw notFound("catalog.price.retire");
    return this.#runtime.mutate({
      operation: "catalog.price.retire",
      key: idempotencyKey,
      payload: { id },
      decodeReplay: decodePrice,
      execute: async (context) => {
        await this.#runtime.requireCapability("catalog.price.retire", context);
        const port = this.#runtime.options.adapter.catalog?.retirePrice;
        if (port === undefined) throw unsupported("catalog.price.retire");
        const externalId = requireExternalId(
          await this.#runtime.options.store.getExternalId(
            this.#runtime.options.tenantId,
            this.#runtime.options.connection.id,
            "price",
            id,
          ),
          "catalog.price.retire",
        );
        const remote = await port(context, externalId);
        const price: Price = { ...current, status: "retired" };
        await this.#runtime.options.store.commitResource({
          ...commitBase(this.#runtime, "price", id, externalId),
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
