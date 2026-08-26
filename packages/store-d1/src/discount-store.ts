import type {
  ArchiveDiscountResult,
  CreateDiscountResult,
  DiscountStore,
} from "@polybill/application";
import {
  money,
  parseId,
  parseIsoDateTime,
  validateDiscount,
  type Discount,
  type DiscountId,
  type IdempotencyKey,
  type TenantId,
} from "@polybill/core";
import type { D1DatabaseLike, D1Result } from "./d1.js";
import { createD1PersistenceAdapter, type D1PersistenceWriter } from "./persistence-adapter.js";

export class D1DiscountStore implements DiscountStore {
  readonly #db: D1DatabaseLike;
  readonly #writes: D1PersistenceWriter;

  constructor(db: D1DatabaseLike, options: { readonly writes?: D1PersistenceWriter } = {}) {
    this.#db = db;
    this.#writes = options.writes ?? createD1PersistenceAdapter(db);
  }

  async createDiscount(
    tenantId: TenantId,
    discount: Discount,
    idempotencyKey: IdempotencyKey,
    payloadHash: string,
  ): Promise<CreateDiscountResult> {
    const existing = await this.#issuance(tenantId, idempotencyKey);
    if (existing !== null) return replayCreate(existing, payloadHash);
    try {
      await this.#db
        .prepare(
          "INSERT INTO polybill_discounts (tenant_id, discount_id, code, status, issuance_key, payload_hash, value) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          tenantId,
          discount.id,
          discount.code,
          discount.status,
          idempotencyKey,
          payloadHash,
          JSON.stringify(discount),
        )
        .run();
      return { kind: "created", discount };
    } catch (error) {
      const raced = await this.#issuance(tenantId, idempotencyKey);
      if (raced !== null) return replayCreate(raced, payloadHash);
      if ((await this.findDiscountByCode(tenantId, discount.code)) !== undefined)
        return { kind: "conflict" };
      throw error;
    }
  }

  async getDiscount(tenantId: TenantId, discountId: DiscountId): Promise<Discount | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_discounts WHERE tenant_id = ? AND discount_id = ?")
      .bind(tenantId, discountId)
      .first<{ value: string }>();
    return row === null ? undefined : decodeDiscount(row.value);
  }

  async findDiscountByCode(tenantId: TenantId, code: string): Promise<Discount | undefined> {
    const row = await this.#db
      .prepare("SELECT value FROM polybill_discounts WHERE tenant_id = ? AND code = ?")
      .bind(tenantId, code)
      .first<{ value: string }>();
    return row === null ? undefined : decodeDiscount(row.value);
  }

  async archiveDiscount(
    input: Parameters<DiscountStore["archiveDiscount"]>[0],
  ): Promise<ArchiveDiscountResult> {
    const replay = await this.#action(input.tenantId, input.idempotencyKey);
    if (replay !== null) return replayArchive(replay, input.payloadHash);
    const current = await this.getDiscount(input.tenantId, input.discountId);
    if (current === undefined) return { kind: "not_found" };
    const archived: Discount = { ...current, status: "archived" };
    try {
      const results = await this.#writes.execute(
        [
          this.#db
            .prepare(
              "UPDATE polybill_discounts SET status = 'archived', update_token = ?, value = ? WHERE tenant_id = ? AND discount_id = ? AND NOT EXISTS (SELECT 1 FROM polybill_discount_actions WHERE tenant_id = ? AND idempotency_key = ?)",
            )
            .bind(
              input.idempotencyKey,
              JSON.stringify(archived),
              input.tenantId,
              input.discountId,
              input.tenantId,
              input.idempotencyKey,
            ),
          this.#db
            .prepare(
              "INSERT INTO polybill_discount_actions (tenant_id, idempotency_key, payload_hash, value) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM polybill_discounts WHERE tenant_id = ? AND discount_id = ? AND update_token = ?)",
            )
            .bind(
              input.tenantId,
              input.idempotencyKey,
              input.payloadHash,
              JSON.stringify(archived),
              input.tenantId,
              input.discountId,
              input.idempotencyKey,
            ),
        ],
        "discount.archive",
      );
      if (changes(results[0]) === 1 && changes(results[1]) === 1)
        return { kind: "archived", discount: archived };
    } catch (error) {
      const raced = await this.#action(input.tenantId, input.idempotencyKey);
      if (raced === null) throw error;
      return replayArchive(raced, input.payloadHash);
    }
    const raced = await this.#action(input.tenantId, input.idempotencyKey);
    return raced === null ? { kind: "conflict" } : replayArchive(raced, input.payloadHash);
  }

  #issuance(tenantId: TenantId, idempotencyKey: IdempotencyKey) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_discounts WHERE tenant_id = ? AND issuance_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ payload_hash: string; value: string }>();
  }

  #action(tenantId: TenantId, idempotencyKey: IdempotencyKey) {
    return this.#db
      .prepare(
        "SELECT payload_hash, value FROM polybill_discount_actions WHERE tenant_id = ? AND idempotency_key = ?",
      )
      .bind(tenantId, idempotencyKey)
      .first<{ payload_hash: string; value: string }>();
  }
}

function replayCreate(
  row: { payload_hash: string; value: string },
  payloadHash: string,
): CreateDiscountResult {
  return row.payload_hash === payloadHash
    ? { kind: "replay", discount: decodeDiscount(row.value) }
    : { kind: "conflict" };
}

function replayArchive(
  row: { payload_hash: string; value: string },
  payloadHash: string,
): ArchiveDiscountResult {
  return row.payload_hash === payloadHash
    ? { kind: "replay", discount: decodeDiscount(row.value) }
    : { kind: "conflict" };
}

function decodeDiscount(value: string): Discount {
  let valueRecord: unknown;
  try {
    valueRecord = JSON.parse(value) as unknown;
  } catch {
    throw invalidDiscount();
  }
  if (!record(valueRecord)) throw invalidDiscount();
  const skuIds = stringArray(valueRecord.eligibleSkuIds);
  const customerRefs = stringArray(valueRecord.eligibleCustomerRefs);
  if (
    typeof valueRecord.code !== "string" ||
    typeof valueRecord.name !== "string" ||
    !record(valueRecord.value) ||
    skuIds === undefined ||
    customerRefs === undefined ||
    (valueRecord.status !== "active" && valueRecord.status !== "archived")
  )
    throw invalidDiscount();

  const discountValue = valueRecord.value;
  const canonicalValue =
    discountValue.kind === "percentage" && typeof discountValue.basisPoints === "number"
      ? { kind: "percentage" as const, basisPoints: discountValue.basisPoints }
      : discountValue.kind === "fixed" && record(discountValue.amount)
        ? {
            kind: "fixed" as const,
            amount: money(
              requiredString(discountValue.amount.amount),
              requiredString(discountValue.amount.currency),
            ),
          }
        : undefined;
  if (canonicalValue === undefined) throw invalidDiscount();

  let discount: Discount;
  try {
    discount = {
      id: parseId<"DiscountId">(valueRecord.id, "disc"),
      code: valueRecord.code,
      name: valueRecord.name,
      value: canonicalValue,
      eligibleSkuIds: skuIds.map((id) => parseId<"SkuId">(id, "sku")),
      eligibleCustomerRefs: customerRefs,
      ...(valueRecord.startsAt === undefined
        ? {}
        : { startsAt: parseIsoDateTime(valueRecord.startsAt) }),
      ...(valueRecord.expiresAt === undefined
        ? {}
        : { expiresAt: parseIsoDateTime(valueRecord.expiresAt) }),
      ...(valueRecord.maxRedemptions === undefined
        ? {}
        : { maxRedemptions: requiredNumber(valueRecord.maxRedemptions) }),
      ...(valueRecord.maxRedemptionsPerCustomer === undefined
        ? {}
        : { maxRedemptionsPerCustomer: requiredNumber(valueRecord.maxRedemptionsPerCustomer) }),
      status: valueRecord.status,
      createdAt: parseIsoDateTime(valueRecord.createdAt),
    };
    validateDiscount(discount);
  } catch {
    throw invalidDiscount();
  }
  return discount;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw invalidDiscount();
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") throw invalidDiscount();
  return value;
}

function invalidDiscount(): TypeError {
  return new TypeError("Stored D1 discount is invalid");
}

function changes(result: D1Result | undefined): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}
