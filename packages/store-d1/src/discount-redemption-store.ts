import type {
  DiscountRedemptionStore,
  DiscountReservation,
  ReserveDiscountResult,
} from "@polybill/application";
import {
  parseId,
  parseIdempotencyKey,
  parseIsoDateTime,
  type DiscountRedemptionId,
  type TenantId,
} from "@polybill/core";
import type { D1DatabaseLike, D1Result } from "./d1.js";

interface RedemptionRow {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly redemption_id: string;
  readonly discount_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly customer_ref: string | null;
  readonly status: string;
  readonly redemption_count_before: number;
  readonly customer_redemption_count_before: number;
  readonly reserved_at: string;
  readonly finalized_at: string | null;
  readonly order_id: string | null;
}

export class D1DiscountRedemptionStore implements DiscountRedemptionStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async reserveDiscount(
    input: Parameters<DiscountRedemptionStore["reserveDiscount"]>[0],
  ): Promise<ReserveDiscountResult> {
    const existing = await this.#byKey(input.tenantId, input.connectionId, input.idempotencyKey);
    if (existing !== null) {
      if (existing.payload_hash !== input.payloadHash) return { kind: "conflict" };
      if (existing.status !== "released")
        return { kind: "replay", reservation: decodeReservation(existing) };
      const activated = await this.#reactivate(input, existing.redemption_id);
      if (changed(activated)) {
        const reservation = await this.#byKey(
          input.tenantId,
          input.connectionId,
          input.idempotencyKey,
        );
        if (reservation === null) throw new Error("D1 discount reservation disappeared");
        return { kind: "reserved", reservation: decodeReservation(reservation) };
      }
      return this.#unavailable(input);
    }

    const inserted = await this.#insert(input);
    if (changed(inserted)) {
      const reservation = await this.#byKey(
        input.tenantId,
        input.connectionId,
        input.idempotencyKey,
      );
      if (reservation === null) throw new Error("D1 discount reservation disappeared");
      return { kind: "reserved", reservation: decodeReservation(reservation) };
    }
    const raced = await this.#byKey(input.tenantId, input.connectionId, input.idempotencyKey);
    if (raced !== null)
      return raced.payload_hash === input.payloadHash
        ? { kind: "replay", reservation: decodeReservation(raced) }
        : { kind: "conflict" };
    return this.#unavailable(input);
  }

  async releaseDiscountReservation(
    tenantId: TenantId,
    reservationId: DiscountRedemptionId,
  ): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE polybill_discount_redemptions SET status = 'released' WHERE tenant_id = ? AND redemption_id = ? AND status = 'reserved'",
      )
      .bind(tenantId, reservationId)
      .run();
  }

  #insert(input: Parameters<DiscountRedemptionStore["reserveDiscount"]>[0]) {
    const activeCount = countSql();
    const customerCount = customerCountSql();
    return this.#db
      .prepare(
        `INSERT INTO polybill_discount_redemptions (tenant_id, connection_id, redemption_id, discount_id, idempotency_key, payload_hash, customer_ref, status, redemption_count_before, customer_redemption_count_before, reserved_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'reserved', (${activeCount}), (${customerCount}), ?
         WHERE EXISTS (SELECT 1 FROM polybill_discounts WHERE tenant_id = ? AND discount_id = ? AND status = 'active')
           AND (? IS NULL OR (${activeCount}) < ?)
           AND (? IS NULL OR (? IS NOT NULL AND (${customerCount}) < ?))
         ON CONFLICT(tenant_id, connection_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        input.tenantId,
        input.connectionId,
        input.reservationId,
        input.discountId,
        input.idempotencyKey,
        input.payloadHash,
        input.customerRef ?? null,
        input.tenantId,
        input.discountId,
        input.tenantId,
        input.discountId,
        input.customerRef ?? null,
        input.reservedAt,
        input.tenantId,
        input.discountId,
        input.maxRedemptions ?? null,
        input.tenantId,
        input.discountId,
        input.maxRedemptions ?? null,
        input.maxRedemptionsPerCustomer ?? null,
        input.customerRef ?? null,
        input.tenantId,
        input.discountId,
        input.customerRef ?? null,
        input.maxRedemptionsPerCustomer ?? null,
      )
      .run();
  }

  #reactivate(
    input: Parameters<DiscountRedemptionStore["reserveDiscount"]>[0],
    redemptionId: string,
  ) {
    const activeCount = countSql();
    const customerCount = customerCountSql();
    return this.#db
      .prepare(
        `UPDATE polybill_discount_redemptions
         SET status = 'reserved', customer_ref = ?, redemption_count_before = (${activeCount}), customer_redemption_count_before = (${customerCount}), reserved_at = ?, finalized_at = NULL, order_id = NULL
         WHERE tenant_id = ? AND redemption_id = ? AND status = 'released' AND payload_hash = ?
           AND EXISTS (SELECT 1 FROM polybill_discounts WHERE tenant_id = ? AND discount_id = ? AND status = 'active')
           AND (? IS NULL OR (${activeCount}) < ?)
           AND (? IS NULL OR (? IS NOT NULL AND (${customerCount}) < ?))`,
      )
      .bind(
        input.customerRef ?? null,
        input.tenantId,
        input.discountId,
        input.tenantId,
        input.discountId,
        input.customerRef ?? null,
        input.reservedAt,
        input.tenantId,
        redemptionId,
        input.payloadHash,
        input.tenantId,
        input.discountId,
        input.maxRedemptions ?? null,
        input.tenantId,
        input.discountId,
        input.maxRedemptions ?? null,
        input.maxRedemptionsPerCustomer ?? null,
        input.customerRef ?? null,
        input.tenantId,
        input.discountId,
        input.customerRef ?? null,
        input.maxRedemptionsPerCustomer ?? null,
      )
      .run();
  }

  async #unavailable(
    input: Parameters<DiscountRedemptionStore["reserveDiscount"]>[0],
  ): Promise<ReserveDiscountResult> {
    const discount = await this.#db
      .prepare("SELECT status FROM polybill_discounts WHERE tenant_id = ? AND discount_id = ?")
      .bind(input.tenantId, input.discountId)
      .first<{ status: string }>();
    return discount === null
      ? { kind: "not_found" }
      : discount.status !== "active"
        ? { kind: "inactive" }
        : { kind: "limit_reached" };
  }

  #byKey(tenantId: TenantId, connectionId: string, idempotencyKey: string) {
    return this.#db
      .prepare(
        "SELECT tenant_id, connection_id, redemption_id, discount_id, idempotency_key, payload_hash, customer_ref, status, redemption_count_before, customer_redemption_count_before, reserved_at, finalized_at, order_id FROM polybill_discount_redemptions WHERE tenant_id = ? AND connection_id = ? AND idempotency_key = ?",
      )
      .bind(tenantId, connectionId, idempotencyKey)
      .first<RedemptionRow>();
  }
}

function countSql(): string {
  return "SELECT COUNT(*) FROM polybill_discount_redemptions WHERE tenant_id = ? AND discount_id = ? AND status IN ('reserved', 'finalized')";
}

function customerCountSql(): string {
  return "SELECT COUNT(*) FROM polybill_discount_redemptions WHERE tenant_id = ? AND discount_id = ? AND customer_ref = ? AND status IN ('reserved', 'finalized')";
}

function decodeReservation(row: RedemptionRow): DiscountReservation {
  if (
    !["reserved", "finalized", "released"].includes(row.status) ||
    !Number.isSafeInteger(row.redemption_count_before) ||
    row.redemption_count_before < 0 ||
    !Number.isSafeInteger(row.customer_redemption_count_before) ||
    row.customer_redemption_count_before < 0
  )
    throw new TypeError("Stored D1 discount reservation is invalid");
  try {
    return {
      id: parseId<"DiscountRedemptionId">(row.redemption_id, "dred"),
      tenantId: parseId<"TenantId">(row.tenant_id, "ten"),
      connectionId: parseId<"ConnectionId">(row.connection_id, "conn"),
      discountId: parseId<"DiscountId">(row.discount_id, "disc"),
      idempotencyKey: parseIdempotencyKey(row.idempotency_key),
      payloadHash: row.payload_hash,
      ...(row.customer_ref === null ? {} : { customerRef: row.customer_ref }),
      status: row.status as DiscountReservation["status"],
      redemptionCountBefore: row.redemption_count_before,
      customerRedemptionCountBefore: row.customer_redemption_count_before,
      reservedAt: parseIsoDateTime(row.reserved_at),
      ...(row.finalized_at === null ? {} : { finalizedAt: parseIsoDateTime(row.finalized_at) }),
      ...(row.order_id === null ? {} : { orderId: parseId<"OrderId">(row.order_id, "ord") }),
    };
  } catch {
    throw new TypeError("Stored D1 discount reservation is invalid");
  }
}

function changed(result: D1Result): boolean {
  return result.meta?.changes === 1;
}
