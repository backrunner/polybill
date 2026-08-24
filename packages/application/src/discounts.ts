import type { CryptoPort } from "@polybill/adapter-kit";
import {
  PolybillError,
  parseId,
  validateDiscount,
  type Clock,
  type Discount,
  type DiscountId,
  type DiscountValue,
  type IdempotencyKey,
  type IsoDateTime,
  type SkuId,
  type TenantId,
} from "@polybill/core";
import type { IdGenerator } from "./ports.js";

export type CreateDiscountResult =
  | { readonly kind: "created"; readonly discount: Discount }
  | { readonly kind: "replay"; readonly discount: Discount }
  | { readonly kind: "conflict" };

export type ArchiveDiscountResult =
  | { readonly kind: "archived"; readonly discount: Discount }
  | { readonly kind: "replay"; readonly discount: Discount }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export interface DiscountStore {
  createDiscount(
    tenantId: TenantId,
    discount: Discount,
    idempotencyKey: IdempotencyKey,
    payloadHash: string,
  ): Promise<CreateDiscountResult>;
  getDiscount(tenantId: TenantId, discountId: DiscountId): Promise<Discount | undefined>;
  findDiscountByCode(tenantId: TenantId, code: string): Promise<Discount | undefined>;
  archiveDiscount(input: {
    readonly tenantId: TenantId;
    readonly discountId: DiscountId;
    readonly idempotencyKey: IdempotencyKey;
    readonly payloadHash: string;
  }): Promise<ArchiveDiscountResult>;
}

export interface DiscountServiceOptions {
  readonly tenantId: TenantId;
  readonly store: DiscountStore;
  readonly crypto: CryptoPort;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateDiscountCommand {
  readonly idempotencyKey: IdempotencyKey;
  readonly code: string;
  readonly name: string;
  readonly value: DiscountValue;
  readonly eligibleSkuIds?: readonly SkuId[];
  readonly eligibleCustomerRefs?: readonly string[];
  readonly startsAt?: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
  readonly maxRedemptions?: number;
  readonly maxRedemptionsPerCustomer?: number;
}

export class DiscountService {
  readonly #options: DiscountServiceOptions;

  constructor(options: DiscountServiceOptions) {
    this.#options = options;
  }

  async create(command: CreateDiscountCommand): Promise<Discount> {
    const code = command.code.trim().toUpperCase();
    const discount: Discount = {
      id: parseId<"DiscountId">(this.#options.ids.next("disc"), "disc"),
      code,
      name: command.name,
      value: command.value,
      eligibleSkuIds: [...(command.eligibleSkuIds ?? [])],
      eligibleCustomerRefs: [...(command.eligibleCustomerRefs ?? [])],
      ...(command.startsAt === undefined ? {} : { startsAt: command.startsAt }),
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      ...(command.maxRedemptions === undefined ? {} : { maxRedemptions: command.maxRedemptions }),
      ...(command.maxRedemptionsPerCustomer === undefined
        ? {}
        : { maxRedemptionsPerCustomer: command.maxRedemptionsPerCustomer }),
      status: "active",
      createdAt: this.#options.clock.now(),
    };
    validateDiscount(discount);
    const payloadHash = await this.#hash({
      code,
      name: command.name,
      value: command.value,
      eligibleSkuIds: command.eligibleSkuIds ?? [],
      eligibleCustomerRefs: command.eligibleCustomerRefs ?? [],
      ...(command.startsAt === undefined ? {} : { startsAt: command.startsAt }),
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      ...(command.maxRedemptions === undefined ? {} : { maxRedemptions: command.maxRedemptions }),
      ...(command.maxRedemptionsPerCustomer === undefined
        ? {}
        : { maxRedemptionsPerCustomer: command.maxRedemptionsPerCustomer }),
    });
    const result = await this.#options.store.createDiscount(
      this.#options.tenantId,
      discount,
      command.idempotencyKey,
      payloadHash,
    );
    if (result.kind === "conflict") throw conflict("Discount code or idempotency key conflict");
    return result.discount;
  }

  async get(discountId: DiscountId): Promise<Discount> {
    const discount = await this.#options.store.getDiscount(this.#options.tenantId, discountId);
    if (discount === undefined) throw notFound();
    return discount;
  }

  async findByCode(code: string): Promise<Discount | undefined> {
    return this.#options.store.findDiscountByCode(
      this.#options.tenantId,
      code.trim().toUpperCase(),
    );
  }

  async archive(discountId: DiscountId, idempotencyKey: IdempotencyKey): Promise<Discount> {
    const result = await this.#options.store.archiveDiscount({
      tenantId: this.#options.tenantId,
      discountId,
      idempotencyKey,
      payloadHash: await this.#hash({ discountId, action: "archive" }),
    });
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "conflict") throw conflict("Discount action idempotency conflict");
    return result.discount;
  }

  async #hash(value: unknown): Promise<string> {
    return this.#options.crypto.sha256(new TextEncoder().encode(stable(value)));
  }
}

function stable(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value === undefined) return "null";
  if (typeof value !== "object") throw new TypeError("Idempotency payload is not serializable");
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function conflict(message: string): PolybillError {
  return new PolybillError(message, {
    code: "idempotency_conflict",
    operation: "discount.mutate",
    retryable: false,
  });
}

function notFound(): PolybillError {
  return new PolybillError("Discount was not found", {
    code: "not_found",
    operation: "discount.read",
    retryable: false,
  });
}
